// popup.js (Tadorun) — i18n 完整対応 & 初期化順序修正

// --- i18n helpers ------------------------------------------------------------
let t = (k, f) => f || k; // I18N.init() 後に実体が入る
const tx = (key, ...args) => (t(key) || key).replace(/\$([0-9]+)/g, (_, i) => String(args[i - 1] ?? ""));

// 言語変更（options保存）通知を受けて再適用
chrome.runtime?.onMessage?.addListener((msg) => {
  if (msg?.type === "langChanged") {
    I18N.init().then((tt) => {
      t = tt;
      const input = document.getElementById("searchInput");
      if (input) input.setAttribute("placeholder", t("ui_searchPlaceholder", input.getAttribute("placeholder")));
      runSearch(); // 動的要素を言語で再描画
    });
  }
});

// --- 状態 --------------------------------------------------------------------
let userOptions = {
  searchMode: "and",
  searchTarget: "both",
  highlight: true,
  historyMaxResults: 10000,
  historyPeriod: 90,
  minQueryLength: 2,
  popupHeight: 600
};

let cachedHistory = [];
let historyCacheTimestamp = 0;                 // UNIXタイム（ミリ秒）
const HISTORY_CACHE_TTL_MS = 60 * 1000;        // 1分間
let historyVisitMap = {};
let currentSearchId = 0;

const selectedIndexMap = { all: -1, bookmarks: -1, history: -1 };

// --- 起動順序を一本化 --------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => { bootstrap(); });

async function bootstrap() {
  // 1) i18n を最優先で初期化（DOM の data-i18n を反映）
  t = await I18N.init();

  // <html lang> をロケールに合わせる（任意）
  try {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
    const l = (langs[0] || "en").toLowerCase();
    document.documentElement.setAttribute("lang", l.startsWith("ja") ? "ja" : "en");
  } catch {}

  // 2) 設定ロード → UI 反映
  chrome.storage.sync.get(
    ["searchMode","searchTarget","highlight","historyMaxResults","historyPeriod","minQueryLength","popupHeight"],
    (data) => {
      userOptions = {
        searchMode: data.searchMode || "and",
        searchTarget: data.searchTarget || "both",
        highlight: data.highlight !== false,
        historyMaxResults: parseInt(data.historyMaxResults) || 10000,
        historyPeriod: data.historyPeriod || 90,
        minQueryLength: parseInt(data.minQueryLength) || 2,
        popupHeight: parseInt(data.popupHeight) || 600
      };

      applyTabVisibility(userOptions.searchTarget);

      // 検索欄の placeholder を i18n で上書き（HTMLに data-i18n-attr がある場合はそちらが適用済み）
      const input = document.getElementById("searchInput");
      if (input) {
        input.setAttribute("placeholder", t("ui_searchPlaceholder", input.getAttribute("placeholder")));
        input.focus();
        if (input.value.trim() === "") setPopupHeight(200);
      }

      // 3) ハンドラ登録（ここから）
      wireEvents();

      // 4) 履歴プリロード & 初回検索
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
  input?.addEventListener("input", runSearch);

  input?.addEventListener("keydown", (e) => {
    const tabId = getActiveTabId();
    const items = document.querySelectorAll(`#results-${tabId} li`);
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
    }
  });

  // 起動直後の高さ（空検索時）
  if (input && input.value.trim() === "") setPopupHeight(200);

  // Tab でタブ移動
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

  // タブクリック
  document.querySelectorAll('#resultTabs .nav-link').forEach(tab => {
    tab.addEventListener('click', () => {
      setActiveTab(tab.dataset.target);
      document.getElementById("searchInput")?.focus();
    });
  });

  // フィルタの開閉で高さ調整
  const collapseEl = document.getElementById('filterPanel');
  if (collapseEl) {
    collapseEl.addEventListener('shown.bs.collapse', () => {
      if (document.getElementById("searchInput").value.trim() === "") {
        setPopupHeight(280);
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

  // クリアボタン
  document.getElementById("clearInputBtn")?.addEventListener("click", () => {
    const input2 = document.getElementById("searchInput");
    input2.value = "";
    input2.focus();
    runSearch(); // 空文字で検索を再実行（結果クリア）
  });
}

// --- 検索コア ----------------------------------------------------------------
function runSearch() {
  const rawQuery = document.getElementById("searchInput").value.trim();
  const normalizedQuery = normalizeForSearch(rawQuery);
  const keywords = normalizedQuery.split(" ").filter(Boolean);
  const thisSearchId = ++currentSearchId;

  Object.keys(selectedIndexMap).forEach(key => selectedIndexMap[key] = -1);

  let countAll = 0, countBookmarks = 0, countHistory = 0;

  const resultsAll = document.getElementById("results-all");
  const resultsBookmarks = document.getElementById("results-bookmarks");
  const resultsHistory = document.getElementById("results-history");
  resultsAll.innerHTML = resultsBookmarks.innerHTML = resultsHistory.innerHTML = "";

  // 空入力：案内メッセージ
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
    return;
  }

  // 最小文字数
  if (rawQuery.length < userOptions.minQueryLength) {
    insertMessageItem(resultsAll, tx("ui_minChars", userOptions.minQueryLength));
    return;
  }

  setPopupHeight(userOptions.popupHeight || 600);
  ["count-all","count-bookmarks","count-history"].forEach(id => {
    document.getElementById(id).style.display = "inline-block";
  });

  if (!normalizedQuery) return;

  const matchFn = (text) => {
    const normalized = normalizeForSearch(text);
    return userOptions.searchMode === "and"
      ? keywords.every(k => normalized.includes(k))
      : keywords.some(k => normalized.includes(k));
  };

  if (userOptions.searchTarget === "history" || userOptions.searchTarget === "both") {
    loadHistoryOnce((historyResults) => {
      if (thisSearchId !== currentSearchId) return;

      const grouped = groupHistoryByUrl(historyResults);

      if (userOptions.searchTarget === "bookmarks" || userOptions.searchTarget === "both") {
        chrome.bookmarks.getTree((nodes) => {
          if (thisSearchId !== currentSearchId) return;
          const matchedBookmarks = renderBookmarks(nodes, keywords, matchFn, resultsAll, resultsBookmarks);
          countBookmarks = matchedBookmarks.length;

          const matchedHistories = renderHistory(grouped, keywords, matchFn, resultsAll, resultsHistory);
          countHistory = matchedHistories.length;

          countAll = countBookmarks + countHistory;
          updateBadgeAndMessages(countAll, countBookmarks, countHistory);

          const allItems = [...matchedBookmarks, ...matchedHistories];
          renderDomainFilters(getDomainFacets(allItems));
        });
      } else {
        const matchedHistories = renderHistory(grouped, keywords, matchFn, resultsAll, resultsHistory);
        countHistory = matchedHistories.length;
        countAll = countHistory;
        updateBadgeAndMessages(countAll, 0, countHistory);
        renderDomainFilters(getDomainFacets(matchedHistories));
      }
    });
  } else if (userOptions.searchTarget === "bookmarks") {
    chrome.bookmarks.getTree((nodes) => {
      const matchedBookmarks = renderBookmarks(nodes, keywords, matchFn, resultsAll, resultsBookmarks);
      countBookmarks = matchedBookmarks.length;
      countAll = countBookmarks;
      updateBadgeAndMessages(countAll, countBookmarks, 0);
      renderDomainFilters(getDomainFacets(matchedBookmarks));
    });
  }
}

// --- 収集/描画 ---------------------------------------------------------------
function collectBookmarks(nodes, result, path = []) {
  for (const node of nodes) {
    if (node.url) {
      result.push({ ...node, folderPath: [...path] });
    } else if (node.children) {
      collectBookmarks(node.children, result, [...path, node.title]);
    }
  }
}

function renderBookmarks(nodes, keywords, matchFn, resultsAll, resultsBookmarks) {
  const matched = [];
  const bookmarks = [];
  collectBookmarks(nodes, bookmarks);
  const allowedDomains = getSelectedDomains();

  for (const b of bookmarks) {
    const domain = new URL(b.url).hostname;
    if (allowedDomains.length && !allowedDomains.includes(domain)) continue;

    const text = (b.title + " " + b.url).toLowerCase();
    if (!matchFn(text)) continue;

    const li = document.createElement("li");
    li.className = "list-group-item";

    const folderLabel = b.folderPath && b.folderPath.length
      ? `<span class="badge bg-secondary me-1">📁 ${b.folderPath.join(" / ")}</span>`
      : "";

    const visitCount = historyVisitMap[b.url] || 0;
    const historyBadge = visitCount > 0
      ? `<span class="badge bg-info text-dark me-1">${tx("ui_visitCount", visitCount)}</span>`
      : "";

    const favicon = `<img src="https://www.google.com/s2/favicons?sz=16&domain_url=${encodeURIComponent(b.url)}" class="me-1" />`;

    const displayTitle = highlightKeywords(b.title, keywords);
    const displayURL   = highlightKeywords(b.url, keywords);

    li.innerHTML = `
      ${favicon}
      ${folderLabel}
      ${historyBadge}
      <a href="${b.url}" target="_blank">${displayTitle}</a>
      <div class="url-text text-muted small ms-4">${displayURL}</div>
    `;
    li.title = b.url;

    const liClone = li.cloneNode(true);
    liClone.addEventListener("click", (e) => {
      if (e.target.tagName.toLowerCase() === "a") return;
      document.querySelectorAll("#resultsWrapper li").forEach(el => el.classList.remove("selected"));
      liClone.classList.add("selected");
      const link = liClone.querySelector("a");
      if (link) window.open(link.href, "_blank");
    });
    resultsBookmarks.appendChild(liClone);

    li.addEventListener("click", (e) => {
      if (e.target.tagName.toLowerCase() === "a") return;
      document.querySelectorAll("#resultsWrapper li").forEach(el => el.classList.remove("selected"));
      li.classList.add("selected");
      const link = li.querySelector("a");
      if (link) window.open(link.href, "_blank");
    });
    resultsAll.appendChild(li);

    matched.push(b);
  }
  return matched;
}

function renderHistory(grouped, keywords, matchFn, resultsAll, resultsHistory) {
  const matched = [];
  const allowedDomains = getSelectedDomains();

  for (const h of grouped) {
    const domain = new URL(h.url).hostname;
    if (allowedDomains.length && !allowedDomains.includes(domain)) continue;

    const text = (h.title + " " + h.url).toLowerCase();
    if (!matchFn(text)) continue;

    const li = document.createElement("li");
    li.className = "list-group-item";

    const favicon = `<img src="https://www.google.com/s2/favicons?sz=16&domain_url=${encodeURIComponent(h.url)}" class="me-1" />`;

    const elapsedTag = h.lastVisitTime
      ? `<span class="badge bg-primary me-1">${formatElapsedTime(h.lastVisitTime)}</span>`
      : "";

    const countBadge = h.visitCount > 0
      ? `<span class="badge bg-info text-dark me-1">${tx("ui_visitCount", h.visitCount)}</span>`
      : "";

    const displayTitle = highlightKeywords(h.title, keywords);
    const displayURL   = highlightKeywords(h.url, keywords);

    li.innerHTML = `
      ${favicon}
      ${elapsedTag}
      ${countBadge}
      <a href="${h.url}" target="_blank">${displayTitle}</a>
      <div class="url-text text-muted small ms-4" title="${h.url}">${displayURL}</div>
    `;
    li.title = h.url;

    const liClone = li.cloneNode(true);
    liClone.addEventListener("click", (e) => {
      if (e.target.tagName.toLowerCase() === "a") return;
      document.querySelectorAll("#resultsWrapper li").forEach(el => el.classList.remove("selected"));
      liClone.classList.add("selected");
      const link = liClone.querySelector("a");
      if (link) window.open(link.href, "_blank");
    });
    resultsHistory.appendChild(liClone);

    li.addEventListener("click", (e) => {
      if (e.target.tagName.toLowerCase() === "a") return;
      document.querySelectorAll("#results li").forEach(el => el.classList.remove("selected"));
      li.classList.add("selected");
      const link = li.querySelector("a");
      if (link) window.open(link.href, "_blank");
    });
    resultsAll.appendChild(li);

    matched.push(h);
  }
  return matched;
}

// --- 補助 --------------------------------------------------------------------
function preloadHistory() {
  const now = Date.now();
  let startTime = 0;
  if (userOptions.historyPeriod !== "all") {
    startTime = now - parseInt(userOptions.historyPeriod) * 24 * 60 * 60 * 1000;
  }
  chrome.history.search({ text: "", maxResults: userOptions.historyMaxResults, startTime }, (results) => {
    cachedHistory = results;
    historyCacheTimestamp = now;
    groupHistoryByUrl(results);
  });
}

function loadHistoryOnce(callback) {
  const now = Date.now();
  const isCacheValid = cachedHistory.length > 0 && (now - historyCacheTimestamp < HISTORY_CACHE_TTL_MS);

  if (isCacheValid) {
    callback(cachedHistory);
    return;
  }

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

function groupHistoryByUrl(results) {
  const grouped = {};
  historyVisitMap = {};
  for (const item of results) {
    const url = item.url;
    if (!grouped[url]) {
      grouped[url] = { ...item, visitCount: item.visitCount };
    } else {
      grouped[url].visitCount += item.visitCount;
    }
    historyVisitMap[url] = (historyVisitMap[url] || 0) + item.visitCount;
  }
  return Object.values(grouped);
}

function normalizeForSearch(str) {
  return str
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60)) // カタカナ→ひらがな
    .replace(/\s+/g, " ")
    .trim();
}

function highlightKeywords(text, rawKeywords) {
  if (!rawKeywords?.length) return text;
  if (!userOptions.highlight) return text;

  const normalizedText = normalizeForSearch(text);
  const highlightMap = new Array(text.length).fill(false);

  for (const raw of rawKeywords) {
    if (!raw) continue;
    const normKey = normalizeForSearch(raw);
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
    result += text[i];
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
  const items = document.querySelectorAll(`#results-${targetId} li`);
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

function renderDomainFilters(domainMap) {
  const container = document.getElementById("domainFilters");
  container.innerHTML = "";

  const sorted = Object.entries(domainMap).sort((a, b) => b[1] - a[1]);

  // 「すべて」
  const all = document.createElement("div");
  all.className = "form-check";
  all.innerHTML = `
    <input class="form-check-input" type="checkbox" id="filter-all" checked>
    <label class="form-check-label" for="filter-all">${t("ui_all")}</label>
  `;
  container.appendChild(all);

  // ドメインごと
  sorted.forEach(([domain, count]) => {
    const id = `filter-${domain.replace(/\./g, "_")}`;
    const div = document.createElement("div");
    div.className = "form-check";
    div.innerHTML = `
      <input class="form-check-input" type="checkbox" id="${id}" data-domain="${domain}" checked>
      <label class="form-check-label" for="${id}">${domain} (${count})</label>
    `;
    container.appendChild(div);
  });

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
    } catch { /* ignore */ }
  }
  return countMap;
}

function getSelectedDomains() {
  const filters = document.querySelectorAll("#domainFilters input[data-domain]:checked");
  return Array.from(filters).map(cb => cb.dataset.domain);
}
