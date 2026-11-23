// popup.js (Tadorun) — v2.7 全機能実装版

// --- i18n helpers ------------------------------------------------------------
let t = (k, f) => f || k;
const tx = (key, ...args) => (t(key) || key).replace(/\$([0-9]+)/g, (_, i) => String(args[i - 1] ?? ""));

function setDocumentLanguage(locale) {
  document.documentElement.setAttribute("lang", LocaleConfig.toHtmlLang(locale));
}

function refreshDocumentLanguage() {
  ChromeApi.getSync([LocaleConfig.STORAGE_KEY], (data, error) => {
    if (error) return setDocumentLanguage(LocaleConfig.DEFAULT_LOCALE);
    const override = data?.[LocaleConfig.STORAGE_KEY];
    const locale = (!override || override === "auto")
      ? (navigator.languages?.[0] || navigator.language || LocaleConfig.DEFAULT_LOCALE)
      : override;
    setDocumentLanguage(locale);
  });
}

chrome.runtime?.onMessage?.addListener((msg) => {
  if (msg?.type === "langChanged") {
    I18N.init().then((tt) => {
      t = tt;
      refreshDocumentLanguage();
      const input = document.getElementById("searchInput");
      if (input) input.setAttribute("placeholder", t("ui_searchPlaceholder", input.getAttribute("placeholder")));
      updateActionTitles();
      if (document.getElementById("savedSearchesDropdown")?.style.display === "block") showSavedSearchesDropdown();
      runSearch();
    });
  }
});

let userOptions = {
  searchMode: "and",
  searchTarget: "both",
  highlight: true,
  groupSameTitle: true,
  historyMaxResults: 10000,
  historyPeriod: 90,
  minQueryLength: 2,
  popupHeight: 600,
  popupWidth: 500,
  sortOrder: "default",
  displayLimit: 50,
  enableRecentSearches: true
};

let cachedHistory = [];
let historyCacheTimestamp = 0;
const HISTORY_CACHE_TTL_MS = 60 * 1000;
let historyLoadInFlight = false;
let historyLoadCallbacks = [];
let cachedRecentlyClosed = [];
let recentlyClosedCacheTimestamp = 0;
const RECENTLY_CLOSED_CACHE_TTL_MS = 15 * 1000;
let recentlyClosedLoadInFlight = false;
let recentlyClosedLoadCallbacks = [];
let historyMetricsMap = new Map();
const historyVisitsCache = new Map();
const HISTORY_VISITS_CACHE_TTL_MS = 60 * 1000;
const HISTORY_VISITS_CONCURRENCY = 6;
const MAX_HISTORY_VISIT_URLS = 200;
const MAX_HISTORY_VISITS_CACHE_ENTRIES = 500;
const historyVisitRequestQueue = [];
let activeHistoryVisitRequests = 0;
let currentSearchId = 0;
let openTabUrls = new Set();

const selectedIndexMap = { all: -1, bookmarks: -1, history: -1 };

// Feature 5: Recent searches
let recentSearchSaveTimer = null;
let suppressEmptyFocusDropdown = false;
const SAVED_SEARCHES_KEY = 'savedSearches';
const MAX_SAVED_SEARCHES = 20;

document.addEventListener("DOMContentLoaded", () => { bootstrap(); });

async function bootstrap() {
  t = await I18N.init();
  refreshDocumentLanguage();

  ChromeApi.getSync(
    ["searchMode","searchTarget","highlight","groupSameTitle","historyMaxResults","historyPeriod",
     "minQueryLength","popupHeight","popupWidth","sortOrder","displayLimit","enableRecentSearches","showFavicons"],
    (data) => {
      userOptions = {
        searchMode: data.searchMode || "and",
        searchTarget: data.searchTarget || "both",
        highlight: data.highlight !== false,
        groupSameTitle: data.groupSameTitle !== false,
        historyMaxResults: parseInt(data.historyMaxResults) || 10000,
        historyPeriod: data.historyPeriod || 90,
        minQueryLength: parseInt(data.minQueryLength) || 2,
        popupHeight: parseInt(data.popupHeight) || 600,
        popupWidth: parseInt(data.popupWidth) || 500,
        sortOrder: data.sortOrder || "default",
        displayLimit: DisplayLimit.fromStorage(data.displayLimit),
        enableRecentSearches: data.enableRecentSearches !== false,
        showFavicons: data.showFavicons !== false
      };

      document.documentElement.style.width = `${userOptions.popupWidth}px`;
      applyTabVisibility(userOptions.searchTarget);

      // Feature 1: Set sort select value
      const sortSel = document.getElementById("sortOrderSelect");
      if (sortSel) sortSel.value = userOptions.sortOrder;

      const input = document.getElementById("searchInput");
      if (input) {
        input.setAttribute("placeholder", t("ui_searchPlaceholder", input.getAttribute("placeholder")));
        input.focus();
        if (input.value.trim() === "") setPopupHeight(200);
      }
      updateActionTitles();

      // Feature 9: Open tabs detection
      ChromeApi.queryTabs({}, (tabs) => {
        openTabUrls = new Set((Array.isArray(tabs) ? tabs : []).map(tab => tab.url).filter(Boolean));
        runSearch();
      });

      wireEvents();
    }
  );
}

function updateActionTitles() {
  const saveSearchBtn = document.getElementById("saveSearchBtn");
  if (saveSearchBtn) {
    const title = `${t("ui_saveSearch", "Save search")} (Ctrl/Cmd+S)`;
    saveSearchBtn.title = title;
    saveSearchBtn.setAttribute("aria-label", title);
  }
}

function wireEvents() {
  document.getElementById("openOptions")?.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL("options.html"));
  });

  const input = document.getElementById("searchInput");
  const debouncedSearch = debounce(runSearch, 150);

  input?.addEventListener("input", () => {
    hideRecentSearchesDropdown();
    hideSavedSearchesDropdown();
    debouncedSearch();
    scheduleRecentSearchSave(input.value.trim());
  });

  // Feature 5: Show recent searches on focus when empty
  input?.addEventListener("focus", () => {
    if (suppressEmptyFocusDropdown) return;
    if (input.value.trim() === "") {
      showRecentSearchesDropdown();
      hideSavedSearchesDropdown();
    }
  });

  // Hide dropdown on blur (delay for click)
  input?.addEventListener("blur", () => {
    setTimeout(() => {
      hideRecentSearchesDropdown();
      hideSavedSearchesDropdown();
    }, 200);
  });

  input?.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const tabs = Array.from(document.querySelectorAll("#resultTabs .nav-link"))
        .filter((tab) => tab.offsetParent !== null);
      if (tabs.length < 2) return;
      e.preventDefault();
      const current = tabs.findIndex((tab) => tab.classList.contains("active"));
      const step = e.key === "ArrowLeft" ? -1 : 1;
      tabs[(current + step + tabs.length) % tabs.length].click();
      return;
    }
    const hasPrimaryModifier = e.ctrlKey || e.metaKey;
    if (hasPrimaryModifier && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (e.shiftKey) toggleSavedSearchesDropdown();
      else saveCurrentSearch();
      return;
    }

    const tabId = getActiveTabId();
    const items = document.querySelectorAll(`#results-${tabId} li.result-item`);
    let currentIndex = selectedIndexMap[tabId];

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!items.length) return;
      currentIndex = (currentIndex + 1) % items.length;
      selectedIndexMap[tabId] = currentIndex;
      updateSelection(items, tabId);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      currentIndex = (currentIndex - 1 + items.length) % items.length;
      selectedIndexMap[tabId] = currentIndex;
      updateSelection(items, tabId);
    } else if (e.key === "Enter") {
      if (currentIndex >= 0 && items[currentIndex]) {
        const link = items[currentIndex].querySelector("a");
        if (link) window.open(link.href, "_blank");
      }
      // Feature 5: Save search on Enter
      const q = input.value.trim();
      if (q.length >= userOptions.minQueryLength) saveRecentSearch(q);
    }
  });

  if (input && input.value.trim() === "") setPopupHeight(200);

  document.querySelectorAll('#resultTabs .nav-link').forEach(tab => {
    tab.addEventListener('click', () => {
      setActiveTab(tab.dataset.target);
      suppressEmptyFocusDropdown = true;
      document.getElementById("searchInput")?.focus();
      setTimeout(() => { suppressEmptyFocusDropdown = false; }, 0);
    });
  });

  const collapseEl = document.getElementById('filterPanel');
  if (collapseEl) {
    collapseEl.addEventListener('shown.bs.collapse', () => {
      if (document.getElementById("searchInput").value.trim() === "") {
        setPopupHeight(320);
      } else {
        setPopupHeight((userOptions.popupHeight || 600) + 100);
      }
    });
    collapseEl.addEventListener('hidden.bs.collapse', () => {
      if (document.getElementById("searchInput").value.trim() === "") {
        setPopupHeight(200);
      }
    });
  }

  document.getElementById("saveSearchBtn")?.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });

  document.getElementById("saveSearchBtn")?.addEventListener("click", () => {
    const query = document.getElementById("searchInput")?.value.trim() || "";
    if (query) saveCurrentSearch();
    else toggleSavedSearchesDropdown();
  });

  document.getElementById("clearInputBtn")?.addEventListener("click", () => {
    const input2 = document.getElementById("searchInput");
    input2.value = "";
    input2.focus();
    hideSavedSearchesDropdown();
    runSearch();
  });

  // Feature 1: Sort order select
  document.getElementById("sortOrderSelect")?.addEventListener("change", (e) => {
    userOptions.sortOrder = e.target.value;
    runSearch();
  });
}

// --- Feature 5: Recent searches helpers --------------------------------------
function scheduleRecentSearchSave(query) {
  if (!userOptions.enableRecentSearches) return;
  clearTimeout(recentSearchSaveTimer);
  if (query.length >= userOptions.minQueryLength) {
    recentSearchSaveTimer = setTimeout(() => saveRecentSearch(query), 1000);
  }
}

function saveRecentSearch(query) {
  if (!userOptions.enableRecentSearches || !query) return;
  ChromeApi.getLocal("recentSearches", (data, error) => {
    if (error) return;
    let searches = Array.isArray(data.recentSearches) ? data.recentSearches : [];
    searches = searches.filter(s => s !== query);
    searches.unshift(query);
    if (searches.length > 10) searches = searches.slice(0, 10);
    ChromeApi.setLocal({ recentSearches: searches });
  });
}

function showRecentSearchesDropdown() {
  if (!userOptions.enableRecentSearches) return;
  ChromeApi.getLocal("recentSearches", (data) => {
    const searches = Array.isArray(data.recentSearches) ? data.recentSearches : [];
    const dropdown = document.getElementById("recentSearchesDropdown");
    if (!dropdown) return;
    if (!searches.length) { dropdown.style.display = "none"; return; }

    dropdown.innerHTML = "";

    const header = document.createElement("div");
    header.className = "recent-header";
    header.textContent = t("ui_recentSearches");
    dropdown.appendChild(header);

    searches.forEach((query) => {
      const item = document.createElement("div");
      item.className = "recent-item";

      const span = document.createElement("span");
      span.className = "recent-text";
      span.textContent = query;

      const delBtn = document.createElement("button");
      delBtn.className = "recent-del";
      delBtn.innerHTML = "&times;";
      delBtn.title = t("ui_clearTitle");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteRecentSearch(query);
      });

      item.appendChild(span);
      item.appendChild(delBtn);
      item.addEventListener("click", () => {
        const input = document.getElementById("searchInput");
        if (input) {
          input.value = query;
          runSearch();
        }
        hideRecentSearchesDropdown();
      });
      dropdown.appendChild(item);
    });

    dropdown.style.display = "block";
  });
}

function hideRecentSearchesDropdown() {
  const dropdown = document.getElementById("recentSearchesDropdown");
  if (dropdown) dropdown.style.display = "none";
}

function deleteRecentSearch(query) {
  ChromeApi.getLocal("recentSearches", (data, error) => {
    if (error) return;
    let searches = Array.isArray(data.recentSearches) ? data.recentSearches : [];
    searches = searches.filter(s => s !== query);
    ChromeApi.setLocal({ recentSearches: searches }, () => {
      showRecentSearchesDropdown();
    });
  });
}

function normalizeSavedSearches(savedSearches) {
  return Array.isArray(savedSearches)
    ? savedSearches.filter((item) => item && typeof item.query === "string" && item.query.trim())
    : [];
}

function loadSavedSearches(callback) {
  ChromeApi.getSync([SAVED_SEARCHES_KEY], (data, error) => {
    if (error) return;
    callback(normalizeSavedSearches(data?.[SAVED_SEARCHES_KEY]));
  });
}

function setSavedSearchButtonActive(isActive) {
  document.getElementById("saveSearchBtn")?.classList.toggle("is-active", isActive);
}

function hideSavedSearchesDropdown() {
  const dropdown = document.getElementById("savedSearchesDropdown");
  if (dropdown) dropdown.style.display = "none";
  setSavedSearchButtonActive(false);
}

function applySavedSearch(query) {
  const input = document.getElementById("searchInput");
  if (!input) return;
  input.value = query;
  input.focus();
  hideSavedSearchesDropdown();
  runSearch();
}

function deleteSavedSearch(id) {
  loadSavedSearches((savedSearches) => {
    const nextSearches = savedSearches.filter((item) => item.id !== id);
    ChromeApi.setSync({ [SAVED_SEARCHES_KEY]: nextSearches }, () => {
      showSavedSearchesDropdown();
    });
  });
}

function showSavedSearchesDropdown() {
  const dropdown = document.getElementById("savedSearchesDropdown");
  if (!dropdown) return;

  loadSavedSearches((savedSearches) => {
    dropdown.innerHTML = "";

    const header = document.createElement("div");
    header.className = "recent-header";
    header.textContent = t("ui_savedSearches", "Saved searches");
    dropdown.appendChild(header);

    if (!savedSearches.length) {
      const empty = document.createElement("div");
      empty.className = "recent-item text-muted";
      empty.textContent = t("ui_noSavedSearches", "No saved searches yet");
      dropdown.appendChild(empty);
    }

    savedSearches.forEach((savedSearch) => {
      const item = document.createElement("div");
      item.className = "recent-item";

      const span = document.createElement("span");
      span.className = "recent-text";
      span.textContent = savedSearch.label || savedSearch.query;

      const delBtn = document.createElement("button");
      delBtn.className = "recent-del";
      delBtn.innerHTML = "&times;";
      delBtn.title = t("ui_deleteSavedSearch", "Delete saved search");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSavedSearch(savedSearch.id);
      });

      item.appendChild(span);
      item.appendChild(delBtn);
      item.addEventListener("click", () => applySavedSearch(savedSearch.query));
      dropdown.appendChild(item);
    });

    dropdown.style.display = "block";
    setSavedSearchButtonActive(true);
  });
}

function toggleSavedSearchesDropdown() {
  const dropdown = document.getElementById("savedSearchesDropdown");
  if (!dropdown) return;
  if (dropdown.style.display === "block") {
    hideSavedSearchesDropdown();
    return;
  }
  hideRecentSearchesDropdown();
  showSavedSearchesDropdown();
}

function saveCurrentSearch() {
  const input = document.getElementById("searchInput");
  const query = input?.value.trim() || "";
  if (query.length < userOptions.minQueryLength) return;

  loadSavedSearches((savedSearches) => {
    const nextSearch = {
      id: String(Date.now()),
      label: query,
      query,
      createdAt: Date.now()
    };
    const deduped = savedSearches.filter((item) => item.query !== query);
    deduped.unshift(nextSearch);
    const limited = deduped.slice(0, MAX_SAVED_SEARCHES);
    ChromeApi.setSync({ [SAVED_SEARCHES_KEY]: limited }, () => {
      showSavedSearchesDropdown();
    });
  });
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch { return false; }
}

// フォールバック用プレースホルダー（グレーの小さいSVG）
const FAVICON_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='2' fill='%23ccc'/%3E%3C/svg%3E";

// Chrome's local favicon cache is used without contacting result websites.
function applyFavicon(imgEl, url) {
  imgEl.width = 16;
  imgEl.height = 16;

  // Chrome内蔵ファビコンキャッシュ（訪問済みサイト・ローカルサイトに有効）
  imgEl.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`);

  imgEl.onerror = function() {
    this.src = FAVICON_PLACEHOLDER;
    this.onerror = null;
  };
}

function runSearch() {
  const rawQuery = document.getElementById("searchInput").value.trim();
  const thisSearchId = ++currentSearchId;

  Object.keys(selectedIndexMap).forEach(key => selectedIndexMap[key] = -1);

  const resultsAll = document.getElementById("results-all");
  const resultsBookmarks = document.getElementById("results-bookmarks");
  const resultsHistory = document.getElementById("results-history");
  resultsAll.innerHTML = resultsBookmarks.innerHTML = resultsHistory.innerHTML = "";
  setHistoryMetricsNotice("");

  if (rawQuery === "") {
    ["count-all","count-bookmarks","count-history"].forEach(id => {
      const b = document.getElementById(id);
      b.textContent = "0";
      b.style.display = "none";
    });
    setPopupHeight(200);
    insertMessageItem(resultsAll,        t("ui_enterKeyword"));
    insertMessageItem(resultsBookmarks,  t("ui_enterKeyword"));
    insertMessageItem(resultsHistory,    t("ui_enterKeyword"));
    renderDomainFilters({});
    renderFolderFilters([]);
    return;
  }

  if (rawQuery.length < userOptions.minQueryLength) {
    ["count-all","count-bookmarks","count-history"].forEach(id => {
      const badge = document.getElementById(id);
      badge.textContent = "0";
      badge.style.display = "none";
    });
    const message = tx("ui_minChars", userOptions.minQueryLength);
    insertMessageItem(resultsAll, message);
    insertMessageItem(resultsBookmarks, message);
    insertMessageItem(resultsHistory, message);
    renderDomainFilters({});
    renderFolderFilters([]);
    setPopupHeight(200);
    return;
  }

  setPopupHeight(userOptions.popupHeight || 600);
  ["count-all","count-bookmarks","count-history"].forEach(id => {
    document.getElementById(id).style.display = "inline-block";
  });

  // Features 6+7: Build match function
  const { fn: matchFn, includeKeywords, error: regexError } = PopupSearch.buildMatchFn(rawQuery, userOptions.searchMode);

  if (!matchFn) {
    const message = tx("ui_regexError", regexError || "invalid");
    insertMessageItem(resultsAll, message);
    insertMessageItem(resultsBookmarks, message);
    insertMessageItem(resultsHistory, message);
    ["count-all","count-bookmarks","count-history"].forEach(id => {
      document.getElementById(id).textContent = "0";
    });
    renderDomainFilters({});
    renderFolderFilters([]);
    return;
  }

  setHistoryMetricsNotice(t("ui_analyzingHistory", "Analyzing access history…"), true);

  // Only highlight include keywords (not exclude, not regex)
  const highlightKeywordList = (userOptions.searchMode === "regex") ? [] : (includeKeywords || []);

  // History is also loaded for bookmark-only searches so bookmark results can
  // receive accurate period counts and last-visit metrics.
  loadHistoryOnce((historyResults) => {
    if (thisSearchId !== currentSearchId) return;

    historyMetricsMap = PopupSearch.buildHistoryMetricsMap(historyResults);

    const continueWithResults = (recentlyClosedResults = []) => {
      if (thisSearchId !== currentSearchId) return;

      let allHistories = [];
      if (userOptions.searchTarget !== "bookmarks") {
        const matching = PopupSearch.collectHistoryMatches(PopupSearch.groupHistoryByUrl(historyResults), matchFn, isSafeUrl);
        const grouped = userOptions.groupSameTitle ? PopupSearch.mergeSameTitleHistory(matching) : matching;
        allHistories = PopupSearch.mergeHistoryWithRecentlyClosed(grouped, recentlyClosedResults.filter(matchFn));
      }

      if (userOptions.searchTarget === "bookmarks" || userOptions.searchTarget === "both") {
        ChromeApi.getBookmarksTree((nodes) => {
          if (thisSearchId !== currentSearchId) return;
          const allBookmarks = PopupSearch.collectBookmarkMatches(nodes, matchFn, isSafeUrl);
          finalizeSearchResults(allBookmarks, allHistories, highlightKeywordList, thisSearchId);
        });
      } else {
        finalizeSearchResults([], allHistories, highlightKeywordList, thisSearchId);
      }
    };

    if (userOptions.searchTarget === "history" || userOptions.searchTarget === "both") {
      loadRecentlyClosedOnce(continueWithResults);
    } else {
      continueWithResults();
    }
  });
}

async function finalizeSearchResults(bookmarks, histories, keywords, searchId) {
  const decoratedBookmarks = bookmarks.map((bookmark) => {
    const metrics = historyMetricsMap.get(bookmark.url) || {};
    return {
      ...bookmark,
      resultType: "bookmark",
      visitMetricsAttempted: true,
      sourceUrls: [bookmark.url],
      visitCount: metrics.visitCount || 0,
      lifetimeVisitCount: metrics.visitCount || 0,
      lastVisitTime: metrics.lastVisitTime || 0
    };
  });
  const decoratedHistories = histories.map((historyItem) => ({
    ...historyItem,
    resultType: "history",
    visitMetricsAttempted: true,
    sourceUrls: [...(historyItem.sourceUrls || [historyItem.url])],
    lifetimeVisitCount: Number(historyItem.visitCount) || 0
  }));

  renderDomainFilters(PopupSearch.getDomainFacets([...decoratedBookmarks, ...decoratedHistories]));
  renderFolderFilters(decoratedBookmarks);
  const selectedBookmarks = filterBookmarkItems(decoratedBookmarks);
  const selectedHistories = filterHistoryItems(decoratedHistories);

  const enriched = await enrichItemsWithVisitMetrics(selectedBookmarks, selectedHistories, () => searchId === currentSearchId);
  if (searchId !== currentSearchId) return;

  setHistoryMetricsNotice(
    enriched.metricsLimited ? tx("ui_metricsLimited", enriched.analyzedUrlCount) : ""
  );

  const filteredBookmarks = enriched.bookmarks;
  const filteredHistories = enriched.histories;
  const resultsAll = document.getElementById("results-all");
  const resultsBookmarks = document.getElementById("results-bookmarks");
  const resultsHistory = document.getElementById("results-history");

  renderAllItems(filteredBookmarks, filteredHistories, keywords, resultsAll);
  renderBookmarkItems(filteredBookmarks, keywords, resultsBookmarks);
  renderHistoryItems(filteredHistories, keywords, resultsHistory);
  updateBadgeAndMessages(
    filteredBookmarks.length + filteredHistories.length,
    filteredBookmarks.length,
    filteredHistories.length
  );
}

async function enrichItemsWithVisitMetrics(bookmarks, histories, shouldContinue = () => true) {
  const limit = Math.max(1, userOptions.displayLimit || 50);
  const desiredItemCount = Math.min(bookmarks.length + histories.length, Math.max(limit * 2, 100));
  const now = Date.now();
  const candidates = [];
  const seenItems = new Set();
  const addCandidate = (item) => {
    if (!item || seenItems.has(item) || candidates.length >= desiredItemCount) return;
    seenItems.add(item);
    candidates.push(item);
  };

  const byPreliminaryPriority = (items) => [...items].sort((a, b) => {
      const openDiff = Number(openTabUrls.has(b.url)) - Number(openTabUrls.has(a.url));
      if (openDiff !== 0) return openDiff;
      const countDiff = (b.visitCount || 0) - (a.visitCount || 0);
      if (countDiff !== 0) return countDiff;
      return (b.lastVisitTime || b.closedAt || 0) - (a.lastVisitTime || a.closedAt || 0);
    });
  const prioritizedBookmarks = byPreliminaryPriority(bookmarks);
  const prioritizedHistories = byPreliminaryPriority(histories);
  const getPrimaryOrder = (items, prioritized) => {
    if (userOptions.sortOrder === "title" || userOptions.sortOrder === "lastVisit") {
      return PopupSearch.applyOpenTabsPriority(PopupSearch.sortItems(items, userOptions.sortOrder), openTabUrls);
    }
    if (userOptions.sortOrder === "visitCount" || userOptions.sortOrder === "trend") return prioritized;
    return PopupSearch.applyOpenTabsPriority(items, openTabUrls);
  };
  const primaryBookmarks = getPrimaryOrder(bookmarks, prioritizedBookmarks);
  const primaryHistories = getPrimaryOrder(histories, prioritizedHistories);
  for (let index = 0; index < limit; index++) {
    addCandidate(primaryBookmarks[index]);
    addCandidate(primaryHistories[index]);
  }

  const priorityLength = Math.max(prioritizedBookmarks.length, prioritizedHistories.length);
  for (let index = 0; index < priorityLength && candidates.length < desiredItemCount; index++) {
    addCandidate(prioritizedBookmarks[index]);
    addCandidate(prioritizedHistories[index]);
  }

  const metricUrls = [];
  const metricUrlSet = new Set();
  for (const item of candidates) {
    const urls = Array.from(new Set((item.sourceUrls || [item.url]).filter(isSafeUrl)));
    if (!urls.length || metricUrls.length + urls.filter((url) => !metricUrlSet.has(url)).length > MAX_HISTORY_VISIT_URLS) {
      continue;
    }
    for (const url of urls) {
      if (!metricUrlSet.has(url)) {
        metricUrlSet.add(url);
        metricUrls.push(url);
      }
    }
  }

  const visitsByUrl = new Map();
  await mapWithConcurrency(metricUrls, HISTORY_VISITS_CONCURRENCY, async (url) => {
    visitsByUrl.set(url, await getHistoryVisitsCached(url, shouldContinue));
  }, shouldContinue);

  if (!shouldContinue()) {
    return { bookmarks, histories, analyzedUrlCount: 0, metricsLimited: false };
  }

  let analyzedItemCount = 0;
  const enrich = (item) => {
    const sourceUrls = item.sourceUrls || [item.url];
    if (!sourceUrls.length || sourceUrls.some((url) => !isSafeUrl(url))) return item;
    const urls = Array.from(new Set(sourceUrls));
    const visitSets = urls.map((url) => visitsByUrl.get(url));
    if (visitSets.some((visits) => !Array.isArray(visits))) return item;
    analyzedItemCount += 1;
    const visits = visitSets.flat();
    return { ...item, ...PopupSearch.summarizeVisits(visits, now, userOptions.historyPeriod) };
  };

  const enrichedBookmarks = bookmarks.map(enrich);
  const enrichedHistories = histories.map(enrich);
  const analyzedUrlCount = metricUrls.filter((url) => Array.isArray(visitsByUrl.get(url))).length;

  return {
    bookmarks: enrichedBookmarks,
    histories: enrichedHistories,
    analyzedUrlCount,
    metricsLimited: analyzedItemCount < bookmarks.length + histories.length
  };
}

async function mapWithConcurrency(items, concurrency, worker, shouldContinue = () => true) {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length && shouldContinue()) {
      const index = nextIndex++;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function getHistoryVisitsCached(url, shouldContinue = () => true) {
  const now = Date.now();
  const cached = historyVisitsCache.get(url);
  if (cached?.visits && cached.expiresAt > now) return Promise.resolve(cached.visits);
  if (cached?.promise) {
    cached.requestState?.consumers.push(shouldContinue);
    return cached.promise;
  }

  const requestState = { consumers: [shouldContinue] };
  const promise = enqueueHistoryVisitRequest(
    url,
    () => requestState.consumers.some((consumer) => consumer())
  ).then((visits) => {
    if (!Array.isArray(visits)) {
      historyVisitsCache.delete(url);
      return null;
    }
    historyVisitsCache.set(url, { visits, expiresAt: Date.now() + HISTORY_VISITS_CACHE_TTL_MS });
    pruneHistoryVisitsCache();
    return visits;
  });
  historyVisitsCache.set(url, { promise, requestState, expiresAt: 0 });
  return promise;
}

function enqueueHistoryVisitRequest(url, shouldRun) {
  return new Promise((resolve) => {
    for (let index = historyVisitRequestQueue.length - 1; index >= 0; index -= 1) {
      const queuedRequest = historyVisitRequestQueue[index];
      if (queuedRequest.shouldRun()) continue;
      historyVisitRequestQueue.splice(index, 1);
      queuedRequest.resolve(null);
    }
    // Newer searches are placed first; stale queued work is discarded by
    // shouldRun before it reaches the Chrome API.
    historyVisitRequestQueue.unshift({ url, resolve, shouldRun });
    drainHistoryVisitRequestQueue();
  });
}

function drainHistoryVisitRequestQueue() {
  while (activeHistoryVisitRequests < HISTORY_VISITS_CONCURRENCY && historyVisitRequestQueue.length) {
    const request = historyVisitRequestQueue.shift();
    if (!request.shouldRun()) {
      request.resolve(null);
      continue;
    }
    activeHistoryVisitRequests += 1;
    ChromeApi.getHistoryVisits(request.url, (visits) => {
      const failed = Boolean(chrome.runtime.lastError);
      activeHistoryVisitRequests -= 1;
      request.resolve(failed ? null : (Array.isArray(visits) ? visits : []));
      drainHistoryVisitRequestQueue();
    });
  }
}

function pruneHistoryVisitsCache() {
  const now = Date.now();
  for (const [url, entry] of historyVisitsCache) {
    if (!entry.promise && entry.expiresAt <= now) historyVisitsCache.delete(url);
  }
  while (historyVisitsCache.size > MAX_HISTORY_VISITS_CACHE_ENTRIES) {
    let removed = false;
    for (const [url, entry] of historyVisitsCache) {
      if (entry?.promise) continue;
      historyVisitsCache.delete(url);
      removed = true;
      break;
    }
    if (!removed) break;
  }
}

function setHistoryMetricsNotice(message, isLoading = false) {
  const notice = document.getElementById("metricsNotice");
  if (!notice) return;
  notice.textContent = message || "";
  notice.classList.toggle("d-none", !message);
  notice.setAttribute("aria-busy", isLoading ? "true" : "false");
}

function getDomainFilterState() {
  const filters = Array.from(document.querySelectorAll("#domainFilters input[data-domain]"));
  return { hasFilters: filters.length > 0, selected: new Set(filters.filter((cb) => cb.checked).map((cb) => cb.dataset.domain)) };
}

function getFolderFilterState() {
  const filters = Array.from(document.querySelectorAll("#folderFilters input[data-folder]"));
  return { hasFilters: filters.length > 0, selected: new Set(filters.filter((cb) => cb.checked).map((cb) => cb.dataset.folder)) };
}

function filterBookmarkItems(items) {
  const domains = getDomainFilterState();
  const folders = getFolderFilterState();
  return items.filter((bookmark) => {
    let domain;
    try { domain = new URL(bookmark.url).hostname; } catch { return false; }
    if (domains.hasFilters && !domains.selected.has(domain)) return false;
    const folderKey = bookmark.folderPath ? bookmark.folderPath.join(" / ") : "";
    if (folders.hasFilters && !folders.selected.has(folderKey)) return false;
    return true;
  });
}

function filterHistoryItems(items) {
  const domains = getDomainFilterState();
  return items.filter((historyItem) => {
    let domain;
    try { domain = new URL(historyItem.url).hostname; } catch { return false; }
    return !domains.hasFilters || domains.selected.has(domain);
  });
}

function renderAllItems(bookmarks, histories, keywords, resultsAll) {
  const combined = [
    ...bookmarks.map((item) => ({ ...item, resultType: "bookmark" })),
    ...histories.map((item) => ({ ...item, resultType: "history" }))
  ];
  const sorted = PopupSearch.applyOpenTabsPriority(PopupSearch.sortItems(combined, userOptions.sortOrder), openTabUrls);
  renderAllBatch(sorted, 0, userOptions.displayLimit || 50, keywords, resultsAll);
}

function renderAllBatch(items, offset, limit, keywords, resultsAll) {
  const batch = items.slice(offset, offset + limit);
  const fragment = document.createDocumentFragment();
  for (const item of batch) {
    fragment.appendChild(item.resultType === "bookmark"
      ? createBookmarkLi(item, keywords)
      : createHistoryLi(item, keywords));
  }
  resultsAll.appendChild(fragment);
  if (offset + limit < items.length) {
    addLoadMoreButton(resultsAll, "all", () => {
      renderAllBatch(items, offset + limit, limit, keywords, resultsAll);
    }, items.length - offset - limit);
  }
}

function renderBookmarkItems(matched, keywords, resultsBookmarks) {
  const sorted = PopupSearch.applyOpenTabsPriority(PopupSearch.sortItems(matched, userOptions.sortOrder), openTabUrls);
  renderBookmarkBatch(sorted, 0, userOptions.displayLimit || 50, keywords, resultsBookmarks);
}

function renderBookmarkBatch(items, offset, limit, keywords, resultsBookmarks) {
  const batch = items.slice(offset, offset + limit);
  const fragBm = document.createDocumentFragment();

  for (const b of batch) {
    fragBm.appendChild(createBookmarkLi(b, keywords));
  }

  resultsBookmarks.appendChild(fragBm);

  if (offset + limit < items.length) {
    const remaining = items.length - offset - limit;
    addLoadMoreButton(resultsBookmarks, "bookmarks", () => {
      renderBookmarkBatch(items, offset + limit, limit, keywords, resultsBookmarks);
    }, remaining);
  }
}

function appendVisitMetricBadges(li, item) {
  const hasPeriodCount = Number.isFinite(item.periodVisitCount);
  if (hasPeriodCount && item.periodVisitCount > 0) {
    const vcBadge = document.createElement("span");
    vcBadge.className = "badge bg-info text-dark me-1";
    vcBadge.textContent = tx("ui_periodVisitCount", item.periodVisitCount);
    li.appendChild(vcBadge);
  }

  if ((item.trendDelta || 0) > 0 && (item.recentVisitCount || 0) >= 2) {
    const trendBadge = document.createElement("span");
    trendBadge.className = "badge bg-success me-1";
    trendBadge.textContent = t("ui_trendingUp", "Trending");
    trendBadge.title = tx("ui_trendChange", item.recentVisitCount || 0, item.previousVisitCount || 0);
    li.appendChild(trendBadge);
  }
}

function createBookmarkLi(b, keywords) {
  const li = document.createElement("li");
  li.className = "list-group-item result-item";

  const url = b.url;
  const isOpen = openTabUrls.has(url);

  // Feature 9: Open tab badge
  if (isOpen) {
    const openBadge = document.createElement("span");
    openBadge.className = "open-tab-badge";
    openBadge.textContent = t("ui_openTab");
    li.appendChild(openBadge);
  }

  // Favicon
  if (userOptions.showFavicons) {
    const favicon = document.createElement("img");
    favicon.className = "me-1";
    applyFavicon(favicon, url);
    li.appendChild(favicon);
  }

  // Folder badge
  if (b.folderPath && b.folderPath.length) {
    const folderBadge = document.createElement("span");
    folderBadge.className = "badge bg-secondary me-1";
    folderBadge.textContent = "📁 " + b.folderPath.join(" / ");
    li.appendChild(folderBadge);
  }

  appendVisitMetricBadges(li, b);

  // Title link
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.innerHTML = PopupSearch.highlightKeywords(b.title || "", keywords, userOptions.highlight);
  li.appendChild(a);

  // URL display
  const urlDiv = document.createElement("div");
  urlDiv.className = "url-text text-muted small ms-4";
  urlDiv.title = url;
  urlDiv.innerHTML = PopupSearch.highlightKeywords(url, keywords, userOptions.highlight);
  li.appendChild(urlDiv);

  li.title = url;

  // Feature 8: Edit/Delete buttons
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "item-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "edit-btn";
  editBtn.title = t("ui_editBookmark");
  editBtn.innerHTML = '<i class="fas fa-pencil-alt"></i>';
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showBookmarkEditForm(li, b);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete-btn";
  deleteBtn.title = t("ui_deleteBookmark");
  deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm(tx("ui_confirmDelete", b.title || url))) {
      ChromeApi.removeBookmark(b.id, () => {
        if (chrome.runtime.lastError) return;
        runSearch();
      });
    }
  });

  actionsDiv.appendChild(editBtn);
  actionsDiv.appendChild(deleteBtn);
  li.appendChild(actionsDiv);

  // Feature 4: Copy button
  li.appendChild(createCopyButton(url));

  // Click to open
  li.addEventListener("click", (e) => {
    if (e.target.tagName.toLowerCase() === "a") return;
    if (e.target.closest(".item-actions") || e.target.closest(".copy-btn") || e.target.closest(".bookmark-edit-form")) return;
    document.querySelectorAll("#resultsWrapper li").forEach(el => el.classList.remove("selected"));
    li.classList.add("selected");
    window.open(url, "_blank");
  });

  return li;
}

function renderHistoryItems(matched, keywords, resultsHistory) {
  const sorted = PopupSearch.applyOpenTabsPriority(PopupSearch.sortItems(matched, userOptions.sortOrder), openTabUrls);
  renderHistoryBatch(sorted, 0, userOptions.displayLimit || 50, keywords, resultsHistory);
}

function renderHistoryBatch(items, offset, limit, keywords, resultsHistory) {
  const batch = items.slice(offset, offset + limit);
  const fragHist = document.createDocumentFragment();

  for (const h of batch) {
    fragHist.appendChild(createHistoryLi(h, keywords));
  }

  resultsHistory.appendChild(fragHist);

  if (offset + limit < items.length) {
    const remaining = items.length - offset - limit;
    addLoadMoreButton(resultsHistory, "history", () => {
      renderHistoryBatch(items, offset + limit, limit, keywords, resultsHistory);
    }, remaining);
  }
}

function createHistoryLi(h, keywords) {
  const li = document.createElement("li");
  li.className = "list-group-item result-item";

  const url = h.url;
  const isOpen = openTabUrls.has(url);

  // Feature 9: Open tab badge
  if (isOpen) {
    const openBadge = document.createElement("span");
    openBadge.className = "open-tab-badge";
    openBadge.textContent = t("ui_openTab");
    li.appendChild(openBadge);
  }

  // Favicon
  if (userOptions.showFavicons) {
    const favicon = document.createElement("img");
    favicon.className = "me-1";
    applyFavicon(favicon, url);
    li.appendChild(favicon);
  }

  if (h.isRecentlyClosed) {
    const closedBadge = document.createElement("span");
    closedBadge.className = "badge bg-warning text-dark me-1";
    closedBadge.textContent = t("ui_recentlyClosed", "Recently closed");
    li.appendChild(closedBadge);
  }

  // Elapsed time badge
  const activityTime = h.latestVisitTime || h.lastVisitTime || h.closedAt || 0;
  if (activityTime) {
    const elapsedBadge = document.createElement("span");
    elapsedBadge.className = "badge bg-primary me-1";
    elapsedBadge.textContent = PopupSearch.formatElapsedTime(activityTime, tx, t);
    li.appendChild(elapsedBadge);
  }

  appendVisitMetricBadges(li, h);

  // Title link
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.innerHTML = PopupSearch.highlightKeywords(h.title || "", keywords, userOptions.highlight);
  li.appendChild(a);

  // URL display
  const urlDiv = document.createElement("div");
  urlDiv.className = "url-text text-muted small ms-4";
  urlDiv.title = url;
  urlDiv.innerHTML = PopupSearch.highlightKeywords(url, keywords, userOptions.highlight);
  li.appendChild(urlDiv);

  li.title = url;

  // Feature 4: Copy button
  li.appendChild(createCopyButton(url));

  // Click to open
  li.addEventListener("click", (e) => {
    if (e.target.tagName.toLowerCase() === "a") return;
    if (e.target.closest(".copy-btn")) return;
    document.querySelectorAll("#resultsWrapper li").forEach(el => el.classList.remove("selected"));
    li.classList.add("selected");
    window.open(url, "_blank");
  });

  return li;
}

// Feature 4: Copy URL button
function createCopyButton(url) {
  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-btn btn btn-sm";
  copyBtn.title = t("ui_copyUrl");
  copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(url).then(() => {
      copyBtn.innerHTML = '<i class="fas fa-check"></i>';
      copyBtn.title = t("ui_copied");
      setTimeout(() => {
        copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
        copyBtn.title = t("ui_copyUrl");
      }, 1500);
    });
  });
  return copyBtn;
}

// Feature 2: Load more button helper
function addLoadMoreButton(listElement, key, onClickFn, remaining) {
  const existing = listElement.querySelector(`.load-more-btn[data-load-more="${key}"]`);
  if (existing) existing.remove();

  const btn = document.createElement("button");
  btn.className = "load-more-btn";
  btn.dataset.loadMore = key;
  btn.textContent = tx("ui_loadMore", remaining);
  btn.addEventListener("click", () => {
    btn.remove();
    onClickFn();
  });
  listElement.appendChild(btn);
}

// Feature 8: Bookmark inline edit form
function showBookmarkEditForm(li, b) {
  // Toggle: remove if already open
  const existing = li.querySelector(".bookmark-edit-form");
  if (existing) { existing.remove(); return; }

  const form = document.createElement("div");
  form.className = "bookmark-edit-form";

  const titleLabel = document.createElement("label");
  titleLabel.className = "small text-muted d-block";
  titleLabel.textContent = t("ui_editTitle");

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "form-control form-control-sm mb-1";
  titleInput.value = b.title || "";

  const urlLabel = document.createElement("label");
  urlLabel.className = "small text-muted d-block";
  urlLabel.textContent = t("ui_editUrl");

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.className = "form-control form-control-sm mb-1";
  urlInput.value = b.url || "";

  const btnRow = document.createElement("div");
  btnRow.className = "d-flex gap-1 mt-1";

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary btn-sm";
  saveBtn.textContent = t("ui_editSave");
  saveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const newTitle = titleInput.value.trim();
    const newUrl = urlInput.value.trim();
    if (!newTitle || !isSafeUrl(newUrl)) return;
    ChromeApi.updateBookmark(b.id, { title: newTitle, url: newUrl }, () => {
      if (chrome.runtime.lastError) return;
      runSearch();
    });
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn-secondary btn-sm";
  cancelBtn.textContent = t("ui_editCancel");
  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    form.remove();
  });

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);

  form.appendChild(titleLabel);
  form.appendChild(titleInput);
  form.appendChild(urlLabel);
  form.appendChild(urlInput);
  form.appendChild(btnRow);

  li.appendChild(form);
  titleInput.focus();
  titleInput.select();
}

function loadRecentlyClosedOnce(callback) {
  const now = Date.now();
  const isCacheValid = recentlyClosedCacheTimestamp > 0 && (now - recentlyClosedCacheTimestamp < RECENTLY_CLOSED_CACHE_TTL_MS);
  if (isCacheValid) { callback(cachedRecentlyClosed); return; }

  recentlyClosedLoadCallbacks.push(callback);
  if (recentlyClosedLoadInFlight) return;
  recentlyClosedLoadInFlight = true;

  ChromeApi.getRecentlyClosed((sessions) => {
    const failed = Boolean(chrome.runtime.lastError);
    const results = failed
      ? []
      : PopupSearch.normalizeRecentlyClosedSessions(sessions).filter((item) => isSafeUrl(item.url));
    if (!failed) {
      cachedRecentlyClosed = results;
      recentlyClosedCacheTimestamp = Date.now();
    }
    recentlyClosedLoadInFlight = false;
    const callbacks = recentlyClosedLoadCallbacks.splice(0);
    callbacks.forEach((queuedCallback) => queuedCallback(results));
  });
}

function loadHistoryOnce(callback) {
  const now = Date.now();
  const isCacheValid = historyCacheTimestamp > 0 && (now - historyCacheTimestamp < HISTORY_CACHE_TTL_MS);
  if (isCacheValid) { callback(cachedHistory); return; }

  historyLoadCallbacks.push(callback);
  if (historyLoadInFlight) return;
  historyLoadInFlight = true;

  let startTime = 0;
  if (userOptions.historyPeriod !== "all") {
    startTime = now - parseInt(userOptions.historyPeriod) * 24 * 60 * 60 * 1000;
  }
  ChromeApi.searchHistory({ text: "", maxResults: userOptions.historyMaxResults, startTime }, (results) => {
    const failed = Boolean(chrome.runtime.lastError);
    const safeResults = failed || !Array.isArray(results) ? [] : results;
    if (!failed) {
      cachedHistory = safeResults;
      historyCacheTimestamp = Date.now();
    }
    historyLoadInFlight = false;
    const callbacks = historyLoadCallbacks.splice(0);
    callbacks.forEach((queuedCallback) => queuedCallback(safeResults));
  });
}

function applyTabVisibility(target) {
  const allTab = document.getElementById("tab-all");
  const bookmarksTab = document.getElementById("tab-bookmarks");
  const historyTab = document.getElementById("tab-history");
  allTab.parentElement.style.display = "none";
  bookmarksTab.parentElement.style.display = "none";
  historyTab.parentElement.style.display = "none";
  switch (target) {
    case "both":
      allTab.parentElement.style.display = "";
      bookmarksTab.parentElement.style.display = "";
      historyTab.parentElement.style.display = "";
      setActiveTab("all");
      break;
    case "bookmarks":
      bookmarksTab.parentElement.style.display = "";
      setActiveTab("bookmarks");
      break;
    case "history":
      historyTab.parentElement.style.display = "";
      setActiveTab("history");
      break;
  }
}

function setActiveTab(targetId) {
  hideRecentSearchesDropdown();
  hideSavedSearchesDropdown();
  document.querySelectorAll('#resultTabs .nav-link').forEach(btn => {
    const isActive = btn.dataset.target === targetId;
    btn.classList.toggle("active", isActive);
  });
  ["all","bookmarks","history"].forEach(id => {
    const list = document.getElementById(`results-${id}`);
    list.classList.toggle("d-none", id !== targetId);
  });
  const items = document.querySelectorAll(`#results-${targetId} li.result-item`);
  updateSelection(items, targetId);
}

function getActiveTabId() {
  const active = document.querySelector("#resultTabs .nav-link.active");
  return active?.dataset.target || "all";
}

function updateSelection(items, tabId) {
  items.forEach(el => el.classList.remove("selected"));
  const index = selectedIndexMap[tabId];
  if (items[index]) {
    items[index].classList.add("selected");
    items[index].scrollIntoView({ block: "nearest" });
  }
}

function setPopupHeight(heightPx) {
  document.documentElement.style.height = `${heightPx}px`;
}

function insertMessageItem(listElement, message) {
  const li = document.createElement("li");
  li.className = "list-group-item text-muted fst-italic";
  li.textContent = message;
  listElement.appendChild(li);
}

// --- Feature 11: Folder filter -----------------------------------------------
function renderFolderFilters(allBookmarks) {
  const container = document.getElementById("folderFilters");
  if (!container) return;

  const uncheckedFolders = new Set();
  container.querySelectorAll("input[data-folder]").forEach(cb => {
    if (!cb.checked) uncheckedFolders.add(cb.dataset.folder);
  });
  container.innerHTML = "";

  if (!allBookmarks.length) return;

  // Collect unique folder paths and their counts
  const folderMap = {};
  for (const b of allBookmarks) {
    const key = b.folderPath ? b.folderPath.join(" / ") : "";
    folderMap[key] = (folderMap[key] || 0) + 1;
  }

  const sorted = Object.entries(folderMap).sort((a, b) => b[1] - a[1]);

  const allDiv = document.createElement("div");
  allDiv.className = "form-check";
  allDiv.innerHTML = `
    <input class="form-check-input" type="checkbox" id="folder-filter-all" checked>
    <label class="form-check-label" for="folder-filter-all">${escapeHtml(t("ui_all"))}</label>
  `;
  container.appendChild(allDiv);

  sorted.forEach(([folderKey, count], index) => {
    const safeId = `folder-filter-${index}`;
    const div = document.createElement("div");
    div.className = "form-check";
    const isChecked = !uncheckedFolders.has(folderKey);
    const label = folderKey || "(root)";
    div.innerHTML = `
      <input class="form-check-input" type="checkbox" id="${escapeHtml(safeId)}" data-folder="${escapeHtml(folderKey)}"${isChecked ? " checked" : ""}>
      <label class="form-check-label" for="${escapeHtml(safeId)}">📁 ${escapeHtml(label)} (${count})</label>
    `;
    container.appendChild(div);
  });

  const anyUnchecked = sorted.some(([folderKey]) => uncheckedFolders.has(folderKey));
  const allCb = document.getElementById("folder-filter-all");
  if (allCb) allCb.checked = !anyUnchecked;

  document.getElementById("folder-filter-all")?.addEventListener("change", (e) => {
    container.querySelectorAll("input[data-folder]").forEach(cb => { cb.checked = e.target.checked; });
    runSearch();
  });

  container.querySelectorAll("input[data-folder]").forEach(checkbox => {
    checkbox.addEventListener("change", () => {
      const allChecked = Array.from(container.querySelectorAll("input[data-folder]")).every(cb => cb.checked);
      const allCb2 = document.getElementById("folder-filter-all");
      if (allCb2) allCb2.checked = allChecked;
      runSearch();
    });
  });
}

// --- Domain filter -----------------------------------------------------------
function renderDomainFilters(domainMap) {
  const container = document.getElementById("domainFilters");
  const uncheckedDomains = new Set();
  container.querySelectorAll("input[data-domain]").forEach(cb => {
    if (!cb.checked) uncheckedDomains.add(cb.dataset.domain);
  });
  container.innerHTML = "";
  const sorted = Object.entries(domainMap).sort((a, b) => b[1] - a[1]);
  const all = document.createElement("div");
  all.className = "form-check";
  all.innerHTML = `
    <input class="form-check-input" type="checkbox" id="filter-all" checked>
    <label class="form-check-label" for="filter-all">${t("ui_all")}</label>
  `;
  container.appendChild(all);
  sorted.forEach(([domain, count], index) => {
    const id = `domain-filter-${index}`;
    const div = document.createElement("div");
    div.className = "form-check";
    const isChecked = !uncheckedDomains.has(domain);
    div.innerHTML = `
      <input class="form-check-input" type="checkbox" id="${id}" data-domain="${escapeHtml(domain)}"${isChecked ? " checked" : ""}>
      <label class="form-check-label" for="${id}">${escapeHtml(domain)} (${count})</label>
    `;
    container.appendChild(div);
  });
  const anyUnchecked = sorted.some(([domain]) => uncheckedDomains.has(domain));
  document.getElementById("filter-all").checked = !anyUnchecked;
  document.getElementById("filter-all").addEventListener("change", (e) => {
    const isChecked = e.target.checked;
    container.querySelectorAll("input[data-domain]").forEach(cb => { cb.checked = isChecked; });
    runSearch();
  });
  container.querySelectorAll("input[data-domain]").forEach(checkbox => {
    checkbox.addEventListener("change", () => {
      const allChecked = Array.from(container.querySelectorAll("input[data-domain]")).every(cb => cb.checked);
      document.getElementById("filter-all").checked = allChecked;
      runSearch();
    });
  });
}

function updateBadgeAndMessages(countAll, countBookmarks, countHistory) {
  document.getElementById("count-all").textContent = countAll;
  document.getElementById("count-bookmarks").textContent = countBookmarks;
  document.getElementById("count-history").textContent = countHistory;
  if (countAll === 0)        insertMessageItem(document.getElementById("results-all"),       t("ui_noResults"));
  if (countBookmarks === 0)  insertMessageItem(document.getElementById("results-bookmarks"), t("ui_noResults"));
  if (countHistory === 0)    insertMessageItem(document.getElementById("results-history"),   t("ui_noResults"));
}
