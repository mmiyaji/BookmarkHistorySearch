// popup.js (Tadorun) — v2.5 全機能実装版

// --- i18n helpers ------------------------------------------------------------
let t = (k, f) => f || k;
const tx = (key, ...args) => (t(key) || key).replace(/\$([0-9]+)/g, (_, i) => String(args[i - 1] ?? ""));

chrome.runtime?.onMessage?.addListener((msg) => {
  if (msg?.type === "langChanged") {
    I18N.init().then((tt) => {
      t = tt;
      const input = document.getElementById("searchInput");
      if (input) input.setAttribute("placeholder", t("ui_searchPlaceholder", input.getAttribute("placeholder")));
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
let historyVisitMap = {};
let currentSearchId = 0;
let openTabUrls = new Set();

const selectedIndexMap = { all: -1, bookmarks: -1, history: -1 };

// Feature 5: Recent searches
let recentSearchSaveTimer = null;

document.addEventListener("DOMContentLoaded", () => { bootstrap(); });

async function bootstrap() {
  t = await I18N.init();
  try {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
    const l = (langs[0] || "en").toLowerCase();
    document.documentElement.setAttribute("lang", l.startsWith("ja") ? "ja" : "en");
  } catch {}

  chrome.storage.sync.get(
    ["searchMode","searchTarget","highlight","groupSameTitle","historyMaxResults","historyPeriod",
     "minQueryLength","popupHeight","popupWidth","sortOrder","displayLimit","enableRecentSearches"],
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
        enableRecentSearches: data.enableRecentSearches !== false
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

      // Feature 9: Open tabs detection
      chrome.tabs.query({}, (tabs) => {
        openTabUrls = new Set(tabs.map(tab => tab.url).filter(Boolean));
      });

      wireEvents();
      preloadHistory();
      runSearch();
    }
  );
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
    debouncedSearch();
    // Feature 5: Schedule save after typing stops
    scheduleRecentSearchSave(input.value.trim());
  });

  // Feature 5: Show recent searches on focus when empty
  input?.addEventListener("focus", () => {
    if (input.value.trim() === "") {
      showRecentSearchesDropdown();
    }
  });

  // Hide dropdown on blur (delay for click)
  input?.addEventListener("blur", () => {
    setTimeout(hideRecentSearchesDropdown, 200);
  });

  input?.addEventListener("keydown", (e) => {
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

  document.getElementById("clearInputBtn")?.addEventListener("click", () => {
    const input2 = document.getElementById("searchInput");
    input2.value = "";
    input2.focus();
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
  chrome.storage.local.get("recentSearches", (data) => {
    let searches = Array.isArray(data.recentSearches) ? data.recentSearches : [];
    searches = searches.filter(s => s !== query);
    searches.unshift(query);
    if (searches.length > 10) searches = searches.slice(0, 10);
    chrome.storage.local.set({ recentSearches: searches });
  });
}

function showRecentSearchesDropdown() {
  if (!userOptions.enableRecentSearches) return;
  chrome.storage.local.get("recentSearches", (data) => {
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
  chrome.storage.local.get("recentSearches", (data) => {
    let searches = Array.isArray(data.recentSearches) ? data.recentSearches : [];
    searches = searches.filter(s => s !== query);
    chrome.storage.local.set({ recentSearches: searches }, () => {
      showRecentSearchesDropdown();
    });
  });
}

// --- Feature 6+7: buildMatchFn with regex + exclude keywords -----------------
function buildMatchFn(rawQuery) {
  if (userOptions.searchMode === "regex") {
    let regex;
    try {
      regex = new RegExp(rawQuery, "i");
    } catch (err) {
      return { fn: null, includeKeywords: [], excludeKeywords: [], error: err.message };
    }
    return { fn: (text) => regex.test(text), includeKeywords: [], excludeKeywords: [] };
  }

  const normalizedQuery = normalizeForSearch(rawQuery);
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const includeKeywords = tokens.filter(k => !k.startsWith("-"));
  const excludeKeywords = tokens.filter(k => k.startsWith("-")).map(k => k.slice(1)).filter(Boolean);

  const fn = (text) => {
    const normalized = normalizeForSearch(text);
    const includeOk = userOptions.searchMode === "and"
      ? includeKeywords.every(k => normalized.includes(k))
      : includeKeywords.length === 0 || includeKeywords.some(k => normalized.includes(k));
    const excludeOk = excludeKeywords.every(k => !normalized.includes(k));
    return includeOk && excludeOk;
  };

  return { fn, includeKeywords, excludeKeywords };
}

// --- Feature 1: Sort items ---------------------------------------------------
function sortItems(items, sortOrder) {
  if (sortOrder === "visitCount") {
    return [...items].sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0));
  } else if (sortOrder === "lastVisit") {
    return [...items].sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));
  } else if (sortOrder === "title") {
    return [...items].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }
  return items; // default
}

// --- Feature 9: Float open tabs to top within current sort -------------------
function applyOpenTabsPriority(items) {
  const open = items.filter(item => openTabUrls.has(item.url));
  const rest = items.filter(item => !openTabUrls.has(item.url));
  return [...open, ...rest];
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

// Chrome内蔵ファビコンキャッシュを使用（外部送信なし・ローカルサイト対応）
function getFaviconUrl(url) {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`);
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
  const { fn: matchFn, includeKeywords, error: regexError } = buildMatchFn(rawQuery);

  if (!matchFn) {
    insertMessageItem(resultsAll, tx("ui_regexError", regexError || "invalid"));
    return;
  }

  // Only highlight include keywords (not exclude, not regex)
  const highlightKeywordList = (userOptions.searchMode === "regex") ? [] : (includeKeywords || []);

  if (userOptions.searchTarget === "history" || userOptions.searchTarget === "both") {
    loadHistoryOnce((historyResults) => {
      if (thisSearchId !== currentSearchId) return;

      let grouped = groupHistoryByUrl(historyResults);
      if (userOptions.groupSameTitle) grouped = mergeSameTitleHistory(grouped);

      if (userOptions.searchTarget === "bookmarks" || userOptions.searchTarget === "both") {
        chrome.bookmarks.getTree((nodes) => {
          if (thisSearchId !== currentSearchId) return;

          const allBookmarks = collectBookmarkMatches(nodes, matchFn);
          const allHistories = collectHistoryMatches(grouped, matchFn);

          renderDomainFilters(getDomainFacets([...allBookmarks, ...allHistories]));
          renderFolderFilters(allBookmarks);

          const countBookmarks = renderBookmarkItems(allBookmarks, highlightKeywordList, resultsAll, resultsBookmarks);
          const countHistory   = renderHistoryItems(allHistories, highlightKeywordList, resultsAll, resultsHistory);
          const countAll = countBookmarks + countHistory;
          updateBadgeAndMessages(countAll, countBookmarks, countHistory);
        });
      } else {
        const allHistories = collectHistoryMatches(grouped, matchFn);
        renderDomainFilters(getDomainFacets(allHistories));
        renderFolderFilters([]);
        const countHistory = renderHistoryItems(allHistories, highlightKeywordList, resultsAll, resultsHistory);
        updateBadgeAndMessages(countHistory, 0, countHistory);
      }
    });
  } else if (userOptions.searchTarget === "bookmarks") {
    chrome.bookmarks.getTree((nodes) => {
      const allBookmarks = collectBookmarkMatches(nodes, matchFn);
      renderDomainFilters(getDomainFacets(allBookmarks));
      renderFolderFilters(allBookmarks);
      const countBookmarks = renderBookmarkItems(allBookmarks, highlightKeywordList, resultsAll, resultsBookmarks);
      updateBadgeAndMessages(countBookmarks, countBookmarks, 0);
    });
  }
}

function collectBookmarks(nodes, result, path = []) {
  for (const node of nodes) {
    if (node.url) {
      result.push({ ...node, folderPath: [...path] });
    } else if (node.children) {
      collectBookmarks(node.children, result, [...path, node.title]);
    }
  }
}

function collectBookmarkMatches(nodes, matchFn) {
  const all = [];
  collectBookmarks(nodes, all);
  return all.filter(b => {
    if (!isSafeUrl(b.url)) return false;
    return matchFn((b.title + " " + b.url).toLowerCase());
  });
}

function collectHistoryMatches(grouped, matchFn) {
  return grouped.filter(h => {
    if (!isSafeUrl(h.url)) return false;
    return matchFn((h.title + " " + h.url).toLowerCase());
  });
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
  filtered = applyOpenTabsPriority(sortItems(filtered, userOptions.sortOrder));

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
  const favicon = document.createElement("img");
  favicon.src = getFaviconUrl(url);
  favicon.className = "me-1";
  li.appendChild(favicon);

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
  a.innerHTML = highlightKeywords(b.title || "", keywords);
  li.appendChild(a);

  // URL display
  const urlDiv = document.createElement("div");
  urlDiv.className = "url-text text-muted small ms-4";
  urlDiv.title = url;
  urlDiv.innerHTML = highlightKeywords(url, keywords);
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
      chrome.bookmarks.remove(b.id, () => {
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
  filtered = applyOpenTabsPriority(sortItems(filtered, userOptions.sortOrder));

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
  const favicon = document.createElement("img");
  favicon.src = getFaviconUrl(url);
  favicon.className = "me-1";
  li.appendChild(favicon);

  // Elapsed time badge
  if (h.lastVisitTime) {
    const elapsedBadge = document.createElement("span");
    elapsedBadge.className = "badge bg-primary me-1";
    elapsedBadge.textContent = formatElapsedTime(h.lastVisitTime);
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
  a.innerHTML = highlightKeywords(h.title || "", keywords);
  li.appendChild(a);

  // URL display
  const urlDiv = document.createElement("div");
  urlDiv.className = "url-text text-muted small ms-4";
  urlDiv.title = url;
  urlDiv.innerHTML = highlightKeywords(url, keywords);
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
    chrome.bookmarks.update(b.id, { title: newTitle, url: newUrl }, () => {
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

function preloadHistory() {
  const now = Date.now();
  let startTime = 0;
  if (userOptions.historyPeriod !== "all") {
    startTime = now - parseInt(userOptions.historyPeriod) * 24 * 60 * 60 * 1000;
  }
  chrome.history.search({ text: "", maxResults: userOptions.historyMaxResults, startTime }, (results) => {
    cachedHistory = results;
    historyCacheTimestamp = now;
    buildHistoryVisitMap(results);
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
  chrome.history.search({ text: "", maxResults: userOptions.historyMaxResults, startTime }, (results) => {
    cachedHistory = results;
    historyCacheTimestamp = Date.now();
    callback(results);
  });
}

function buildHistoryVisitMap(results) {
  historyVisitMap = {};
  for (const item of results) {
    historyVisitMap[item.url] = (historyVisitMap[item.url] || 0) + item.visitCount;
  }
}

function groupHistoryByUrl(results) {
  const grouped = {};
  historyVisitMap = {};
  for (const item of results) {
    const url = item.url;
    if (!grouped[url]) {
      grouped[url] = { ...item };
    } else {
      grouped[url].visitCount += item.visitCount;
      if (item.lastVisitTime > grouped[url].lastVisitTime) {
        grouped[url].lastVisitTime = item.lastVisitTime;
      }
    }
    historyVisitMap[url] = (historyVisitMap[url] || 0) + item.visitCount;
  }
  return Object.values(grouped);
}

function mergeSameTitleHistory(grouped) {
  const mergeMap = new Map();
  for (const item of grouped) {
    let baseKey;
    try {
      const u = new URL(item.url);
      baseKey = (item.title || "") + "\0" + u.protocol + "//" + u.hostname + u.pathname;
    } catch {
      baseKey = (item.title || "") + "\0" + item.url;
    }
    const existing = mergeMap.get(baseKey);
    if (!existing) {
      mergeMap.set(baseKey, { ...item });
    } else {
      existing.visitCount += item.visitCount;
      if (item.lastVisitTime > existing.lastVisitTime) {
        existing.lastVisitTime = item.lastVisitTime;
        existing.url = item.url;
      }
    }
  }
  return Array.from(mergeMap.values());
}

function normalizeForSearch(str) {
  return str
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/\s+/g, " ")
    .trim();
}

function highlightKeywords(text, rawKeywords) {
  if (!rawKeywords?.length || !userOptions.highlight) return escapeHtml(text);
  const normalizedText = normalizeForSearch(text);
  const highlightMap = new Array(text.length).fill(false);
  for (const raw of rawKeywords) {
    if (!raw) continue;
    const normKey = normalizeForSearch(raw);
    if (!normKey) continue;
    let start = 0;
    while (true) {
      const index = normalizedText.indexOf(normKey, start);
      if (index === -1) break;
      for (let i = index; i < index + normKey.length; i++) highlightMap[i] = true;
      start = index + normKey.length;
    }
  }
  let result = "";
  let inMark = false;
  for (let i = 0; i < text.length; i++) {
    if (highlightMap[i] && !inMark) { result += "<mark>"; inMark = true; }
    else if (!highlightMap[i] && inMark) { result += "</mark>"; inMark = false; }
    result += escapeHtml(text[i]);
  }
  if (inMark) result += "</mark>";
  return result;
}

function formatElapsedTime(ms) {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60000);
  const hours   = Math.floor(minutes / 60);
  const days    = Math.floor(hours / 24);
  if (days > 0)    return tx("ui_daysAgo",    days);
  if (hours > 0)   return tx("ui_hoursAgo",   hours);
  if (minutes > 0) return tx("ui_minutesAgo", minutes);
  return t("ui_justNow");
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

function getDomainFacets(results) {
  const countMap = {};
  for (const item of results) {
    try {
      const domain = new URL(item.url).hostname;
      countMap[domain] = (countMap[domain] || 0) + 1;
    } catch { }
  }
  return countMap;
}

function getSelectedDomains() {
  const filters = document.querySelectorAll("#domainFilters input[data-domain]:checked");
  return Array.from(filters).map(cb => cb.dataset.domain);
}
