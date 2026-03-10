// popup.js (Tadorun) — v2.5 全機能実装版

// --- i18n helpers ------------------------------------------------------------
let t = (k, f) => f || k;
const tx = (key, ...args) => (t(key) || key).replace(/\$([0-9]+)/g, (_, i) => String(args[i - 1] ?? ""));

function setDocumentLanguage(locale) {
  document.documentElement.setAttribute("lang", LocaleConfig.toHtmlLang(locale));
}

function refreshDocumentLanguage() {
  ChromeApi.getSync([LocaleConfig.STORAGE_KEY], (data) => {
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
let cachedRecentlyClosed = [];
let recentlyClosedCacheTimestamp = 0;
const RECENTLY_CLOSED_CACHE_TTL_MS = 15 * 1000;
let historyVisitMap = {};
let currentSearchId = 0;
let openTabUrls = new Set();

const selectedIndexMap = { all: -1, bookmarks: -1, history: -1 };

// Feature 5: Recent searches
let recentSearchSaveTimer = null;
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
        displayLimit: parseInt(data.displayLimit) || 50,
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
        openTabUrls = new Set(tabs.map(tab => tab.url).filter(Boolean));
      });

      wireEvents();
      preloadHistory();
      runSearch();
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

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const tabButtons = Array.from(document.querySelectorAll('#resultTabs .nav-link'))
      .filter(btn => btn.offsetParent !== null);
    if (!tabButtons.length) return;
    e.preventDefault();
    const currentIndex = tabButtons.findIndex(btn => btn.classList.contains("active"));
    const nextIndex = e.shiftKey
      ? (currentIndex - 1 + tabButtons.length) % tabButtons.length
      : (currentIndex + 1) % tabButtons.length;
    tabButtons[nextIndex].click();
  });

  document.querySelectorAll('#resultTabs .nav-link').forEach(tab => {
    tab.addEventListener('click', () => {
      setActiveTab(tab.dataset.target);
      document.getElementById("searchInput")?.focus();
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
  ChromeApi.getLocal("recentSearches", (data) => {
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
  ChromeApi.getLocal("recentSearches", (data) => {
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
  ChromeApi.getSync([SAVED_SEARCHES_KEY], (data) => {
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

// ① Chrome内蔵キャッシュ → ② サイト自身の /favicon.ico → ③ SVGプレースホルダー
function applyFavicon(imgEl, url) {
  imgEl.width = 16;
  imgEl.height = 16;

  // ① Chrome内蔵ファビコンキャッシュ（訪問済みサイト・ローカルサイトに有効）
  imgEl.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`);

  imgEl.onerror = function() {
    // ② サイト自身の favicon.ico を試す（ローカルサイト未訪問でも取得可能）
    try {
      const origin = new URL(url).origin;
      this.src = origin + '/favicon.ico';
      this.onerror = function() {
        // ③ 最終フォールバック：SVGプレースホルダー
        this.src = FAVICON_PLACEHOLDER;
        this.onerror = null;
      };
    } catch {
      this.src = FAVICON_PLACEHOLDER;
      this.onerror = null;
    }
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
    insertMessageItem(resultsAll, tx("ui_minChars", userOptions.minQueryLength));
    return;
  }

  setPopupHeight(userOptions.popupHeight || 600);
  ["count-all","count-bookmarks","count-history"].forEach(id => {
    document.getElementById(id).style.display = "inline-block";
  });

  // Features 6+7: Build match function
  const { fn: matchFn, includeKeywords, error: regexError } = PopupSearch.buildMatchFn(rawQuery, userOptions.searchMode);

  if (!matchFn) {
    insertMessageItem(resultsAll, tx("ui_regexError", regexError || "invalid"));
    return;
  }

  // Only highlight include keywords (not exclude, not regex)
  const highlightKeywordList = (userOptions.searchMode === "regex") ? [] : (includeKeywords || []);

  if (userOptions.searchTarget === "history" || userOptions.searchTarget === "both") {
    loadHistoryOnce((historyResults) => {
      if (thisSearchId !== currentSearchId) return;

      historyVisitMap = PopupSearch.buildHistoryVisitMap(historyResults);
      let grouped = PopupSearch.groupHistoryByUrl(historyResults);
      if (userOptions.groupSameTitle) grouped = PopupSearch.mergeSameTitleHistory(grouped);

      loadRecentlyClosedOnce((recentlyClosedResults) => {
        if (thisSearchId !== currentSearchId) return;

        const matchingRecentlyClosed = recentlyClosedResults.filter((item) => matchFn(item));
        const mergedHistories = PopupSearch.mergeHistoryWithRecentlyClosed(grouped, matchingRecentlyClosed);

        if (userOptions.searchTarget === "bookmarks" || userOptions.searchTarget === "both") {
          ChromeApi.getBookmarksTree((nodes) => {
            if (thisSearchId !== currentSearchId) return;

            const allBookmarks = PopupSearch.collectBookmarkMatches(nodes, matchFn, isSafeUrl);
            const allHistories = PopupSearch.collectHistoryMatches(mergedHistories, matchFn, isSafeUrl);

            renderDomainFilters(PopupSearch.getDomainFacets([...allBookmarks, ...allHistories]));
            renderFolderFilters(allBookmarks);

            const countBookmarks = renderBookmarkItems(allBookmarks, highlightKeywordList, resultsAll, resultsBookmarks);
            const countHistory = renderHistoryItems(allHistories, highlightKeywordList, resultsAll, resultsHistory);
            const countAll = countBookmarks + countHistory;
            updateBadgeAndMessages(countAll, countBookmarks, countHistory);
          });
        } else {
          const allHistories = PopupSearch.collectHistoryMatches(mergedHistories, matchFn, isSafeUrl);
          renderDomainFilters(PopupSearch.getDomainFacets(allHistories));
          renderFolderFilters([]);
          const countHistory = renderHistoryItems(allHistories, highlightKeywordList, resultsAll, resultsHistory);
          updateBadgeAndMessages(countHistory, 0, countHistory);
        }
      });
    });
  } else if (userOptions.searchTarget === "bookmarks") {
    ChromeApi.getBookmarksTree((nodes) => {
      const allBookmarks = PopupSearch.collectBookmarkMatches(nodes, matchFn, isSafeUrl);
      renderDomainFilters(PopupSearch.getDomainFacets(allBookmarks));
      renderFolderFilters(allBookmarks);
      const countBookmarks = renderBookmarkItems(allBookmarks, highlightKeywordList, resultsAll, resultsBookmarks);
      updateBadgeAndMessages(countBookmarks, countBookmarks, 0);
    });
  }
}

// Feature 10: DocumentFragment + Features 1,2,4,8,9,11
function renderBookmarkItems(matched, keywords, resultsAll, resultsBookmarks) {
  const allowedDomains = getSelectedDomains();
  const allowedFolders = getSelectedFolders();

  let filtered = matched.filter(b => {
    let domain;
    try { domain = new URL(b.url).hostname; } catch { return false; }
    if (allowedDomains.length && !allowedDomains.includes(domain)) return false;
    if (allowedFolders.length) {
      const folderKey = b.folderPath ? b.folderPath.join(" / ") : "";
      if (!allowedFolders.includes(folderKey)) return false;
    }
    return true;
  });

  // Feature 1 + 9: Sort then open tabs priority
  filtered = PopupSearch.applyOpenTabsPriority(PopupSearch.sortItems(filtered, userOptions.sortOrder), openTabUrls);

  const limit = userOptions.displayLimit || 50;
  renderBookmarkBatch(filtered, 0, limit, keywords, resultsAll, resultsBookmarks);

  return filtered.length;
}

function renderBookmarkBatch(items, offset, limit, keywords, resultsAll, resultsBookmarks) {
  const batch = items.slice(offset, offset + limit);
  const fragAll = resultsAll ? document.createDocumentFragment() : null;
  const fragBm = document.createDocumentFragment();

  for (const b of batch) {
    if (fragAll) fragAll.appendChild(createBookmarkLi(b, keywords));
    fragBm.appendChild(createBookmarkLi(b, keywords));
  }

  if (resultsAll && fragAll) resultsAll.appendChild(fragAll);
  resultsBookmarks.appendChild(fragBm);

  // Feature 2: Load more
  if (offset + limit < items.length) {
    const remaining = items.length - offset - limit;
    if (resultsAll) {
      addLoadMoreButton(resultsAll, () => {
        renderBookmarkBatch(items, offset + limit, limit, keywords, resultsAll, resultsBookmarks);
      }, remaining);
    }
    addLoadMoreButton(resultsBookmarks, () => {
      renderBookmarkBatch(items, offset + limit, limit, keywords, null, resultsBookmarks);
    }, remaining);
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

  // Visit count badge
  const visitCount = historyVisitMap[url] || 0;
  if (visitCount > 0) {
    const vcBadge = document.createElement("span");
    vcBadge.className = "badge bg-info text-dark me-1";
    vcBadge.textContent = tx("ui_visitCount", visitCount);
    li.appendChild(vcBadge);
  }

  // Title link
  const a = document.createElement("a");
  a.href = escapeHtml(url);
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
        li.remove();
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
    if (e.target.closest(".item-actions") || e.target.closest(".copy-btn")) return;
    document.querySelectorAll("#resultsWrapper li").forEach(el => el.classList.remove("selected"));
    li.classList.add("selected");
    window.open(url, "_blank");
  });

  return li;
}

// Feature 10: DocumentFragment + Features 1,2,4,9
function renderHistoryItems(matched, keywords, resultsAll, resultsHistory) {
  const allowedDomains = getSelectedDomains();

  let filtered = matched.filter(h => {
    let domain;
    try { domain = new URL(h.url).hostname; } catch { return false; }
    if (allowedDomains.length && !allowedDomains.includes(domain)) return false;
    return true;
  });

  // Feature 1 + 9
  filtered = PopupSearch.applyOpenTabsPriority(PopupSearch.sortItems(filtered, userOptions.sortOrder), openTabUrls);

  const limit = userOptions.displayLimit || 50;
  renderHistoryBatch(filtered, 0, limit, keywords, resultsAll, resultsHistory);

  return filtered.length;
}

function renderHistoryBatch(items, offset, limit, keywords, resultsAll, resultsHistory) {
  const batch = items.slice(offset, offset + limit);
  const fragAll = resultsAll ? document.createDocumentFragment() : null;
  const fragHist = document.createDocumentFragment();

  for (const h of batch) {
    if (fragAll) fragAll.appendChild(createHistoryLi(h, keywords));
    fragHist.appendChild(createHistoryLi(h, keywords));
  }

  if (resultsAll && fragAll) resultsAll.appendChild(fragAll);
  resultsHistory.appendChild(fragHist);

  // Feature 2: Load more
  if (offset + limit < items.length) {
    const remaining = items.length - offset - limit;
    if (resultsAll) {
      addLoadMoreButton(resultsAll, () => {
        renderHistoryBatch(items, offset + limit, limit, keywords, resultsAll, resultsHistory);
      }, remaining);
    }
    addLoadMoreButton(resultsHistory, () => {
      renderHistoryBatch(items, offset + limit, limit, keywords, null, resultsHistory);
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
  if (h.lastVisitTime) {
    const elapsedBadge = document.createElement("span");
    elapsedBadge.className = "badge bg-primary me-1";
    elapsedBadge.textContent = PopupSearch.formatElapsedTime(h.lastVisitTime, tx, t);
    li.appendChild(elapsedBadge);
  }

  // Visit count badge
  if (h.visitCount > 0) {
    const vcBadge = document.createElement("span");
    vcBadge.className = "badge bg-info text-dark me-1";
    vcBadge.textContent = tx("ui_visitCount", h.visitCount);
    li.appendChild(vcBadge);
  }

  // Title link
  const a = document.createElement("a");
  a.href = escapeHtml(url);
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
function addLoadMoreButton(listElement, onClickFn, remaining) {
  // Remove existing load-more if any
  const existing = listElement.querySelector(".load-more-btn");
  if (existing) existing.remove();

  const btn = document.createElement("button");
  btn.className = "load-more-btn";
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
      b.title = newTitle;
      b.url = newUrl;
      // Update displayed content
      const anchor = li.querySelector("a");
      if (anchor) {
        anchor.href = escapeHtml(newUrl);
        anchor.innerHTML = escapeHtml(newTitle);
      }
      const urlDiv = li.querySelector(".url-text");
      if (urlDiv) { urlDiv.title = newUrl; urlDiv.textContent = newUrl; }
      li.title = newUrl;
      form.remove();
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
  const isCacheValid = cachedRecentlyClosed.length > 0 && (now - recentlyClosedCacheTimestamp < RECENTLY_CLOSED_CACHE_TTL_MS);
  if (isCacheValid) { callback(cachedRecentlyClosed); return; }
  ChromeApi.getRecentlyClosed((sessions) => {
    cachedRecentlyClosed = PopupSearch.normalizeRecentlyClosedSessions(sessions).filter((item) => isSafeUrl(item.url));
    recentlyClosedCacheTimestamp = Date.now();
    callback(cachedRecentlyClosed);
  });
}

function preloadHistory() {
  const now = Date.now();
  let startTime = 0;
  if (userOptions.historyPeriod !== "all") {
    startTime = now - parseInt(userOptions.historyPeriod) * 24 * 60 * 60 * 1000;
  }
  ChromeApi.searchHistory({ text: "", maxResults: userOptions.historyMaxResults, startTime }, (results) => {
    cachedHistory = results;
    historyCacheTimestamp = now;
    historyVisitMap = PopupSearch.buildHistoryVisitMap(results);
  });
}

function loadHistoryOnce(callback) {
  const now = Date.now();
  const isCacheValid = cachedHistory.length > 0 && (now - historyCacheTimestamp < HISTORY_CACHE_TTL_MS);
  if (isCacheValid) { callback(cachedHistory); return; }
  let startTime = 0;
  if (userOptions.historyPeriod !== "all") {
    startTime = now - parseInt(userOptions.historyPeriod) * 24 * 60 * 60 * 1000;
  }
  ChromeApi.searchHistory({ text: "", maxResults: userOptions.historyMaxResults, startTime }, (results) => {
    cachedHistory = results;
    historyCacheTimestamp = Date.now();
    callback(results);
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

  sorted.forEach(([folderKey, count]) => {
    const safeId = "folder-" + folderKey.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
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

function getSelectedFolders() {
  const filters = document.querySelectorAll("#folderFilters input[data-folder]:checked");
  return Array.from(filters).map(cb => cb.dataset.folder);
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
  sorted.forEach(([domain, count]) => {
    const id = `filter-${domain.replace(/\./g, "_")}`;
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

function getSelectedDomains() {
  const filters = document.querySelectorAll("#domainFilters input[data-domain]:checked");
  return Array.from(filters).map(cb => cb.dataset.domain);
}
