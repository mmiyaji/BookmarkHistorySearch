let userOptions = {
  searchMode: "and",
  searchTarget: "both",
  highlight: true,
  historyMaxResults: 10000,
  historyPeriod: 30,
  minQueryLength: 2,
};
let cachedHistory = [];
let historyCacheTimestamp = 0; // UNIXタイム（ミリ秒）
const HISTORY_CACHE_TTL_MS = 60 * 1000; // 1分間
let historyVisitMap = {};
let currentSearchId = 0;

chrome.storage.sync.get([
  "searchMode",
  "searchTarget",
  "highlight",
  "historyMaxResults",
  "historyPeriod",
  "minQueryLength"
], (data) => {
  userOptions = {
    searchMode: data.searchMode || "and",
    searchTarget: data.searchTarget || "both",
    highlight: data.highlight !== false,
    historyMaxResults: parseInt(data.historyMaxResults) || 10000,
    historyPeriod: data.historyPeriod || 30,
    minQueryLength: parseInt(data.minQueryLength) || 2
  };
  applyTabVisibility(userOptions.searchTarget);
  runSearch();
});

const selectedIndexMap = {
  all: -1,
  bookmarks: -1,
  history: -1
};

function preloadHistory() {
  const now = Date.now();
  let startTime = 0;
  if (userOptions.historyPeriod !== "all") {
    startTime = now - parseInt(userOptions.historyPeriod) * 24 * 60 * 60 * 1000;
  }
  chrome.history.search({ text: "", maxResults: userOptions.historyMaxResults, startTime: startTime }, (results) => {
    cachedHistory = results;
    historyCacheTimestamp = now;
    groupHistoryByUrl(results);
  });
}

document.getElementById("openOptions").addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL("options.html"));
  }
});

window.addEventListener("DOMContentLoaded", () => {
  preloadHistory(); // ポップアップ表示直後に実行
});

document.getElementById("searchInput").focus();
document.getElementById("searchInput").addEventListener("input", runSearch);
document.getElementById("searchInput").addEventListener("keydown", (e) => {
  const tabId = getActiveTabId();
  const items = document.querySelectorAll(`#results-${tabId} li`);
  let currentIndex = selectedIndexMap[tabId];

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (items.length === 0) return;
    currentIndex = (currentIndex + 1) % items.length;
    selectedIndexMap[tabId] = currentIndex;
    updateSelection(items, tabId);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (items.length === 0) return;
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
window.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("searchInput");
  if (input.value.trim() === "") {
    setPopupHeight(200);
  }
});
document.addEventListener("keydown", (e) => {
  // Tabキー押下時（Shiftキー併用で逆方向）
  if (e.key === "Tab") {
    const tabButtons = Array.from(document.querySelectorAll('#resultTabs .nav-link'))
      .filter(btn => btn.offsetParent !== null); // 非表示タブは除外

    if (tabButtons.length === 0) return;

    e.preventDefault();

    const currentIndex = tabButtons.findIndex(btn => btn.classList.contains("active"));
    let nextIndex;

    if (e.shiftKey) {
      // Shift+Tab → 前のタブ
      nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    } else {
      // Tab → 次のタブ
      nextIndex = (currentIndex + 1) % tabButtons.length;
    }

    const nextTab = tabButtons[nextIndex];
    nextTab.click(); // 次のタブを選択
  }
});

document.querySelectorAll('#resultTabs .nav-link').forEach(tab => {
  tab.addEventListener('click', () => {
    setActiveTab(tab.dataset.target);

    // 🔧 カーソルブラウジング対策：input にフォーカスを戻す
    const input = document.getElementById("searchInput");
    if (input) input.focus();
  });
});

document.getElementById("clearInputBtn").addEventListener("click", () => {
  const input = document.getElementById("searchInput");
  input.value = "";
  input.focus();
  runSearch(); // 空文字で検索を再実行（結果クリア）
});
function runSearch() {
  const rawQuery = document.getElementById("searchInput").value.trim();
  const normalizedQuery = normalizeForSearch(rawQuery);
  const keywords = normalizedQuery.split(" ");
  const thisSearchId = ++currentSearchId;

  Object.keys(selectedIndexMap).forEach(key => selectedIndexMap[key] = -1);

  let countAll = 0;
  let countBookmarks = 0;
  let countHistory = 0;
  
  const resultsAll = document.getElementById("results-all");
  const resultsBookmarks = document.getElementById("results-bookmarks");
  const resultsHistory = document.getElementById("results-history");
  
  resultsAll.innerHTML = "";
  resultsBookmarks.innerHTML = "";
  resultsHistory.innerHTML = "";  
  
  // 検索欄が空の場合は件数バッジもリセットして終了
  if (rawQuery === "") {
    // cachedHistory = [];
    // historyCacheTimestamp = 0;
    ["count-all", "count-bookmarks", "count-history"].forEach(id => {
      const badge = document.getElementById(id);
      badge.textContent = "0";
      badge.style.display = "none";
    });
    setPopupHeight(200);
    insertMessageItem(resultsAll, "検索キーワードを入力してください");
    insertMessageItem(resultsBookmarks, "検索キーワードを入力してください");
    insertMessageItem(resultsHistory, "検索キーワードを入力してください");
    return;
  }
  if (rawQuery.length < userOptions.minQueryLength) {
    insertMessageItem(document.getElementById("results-all"), `検索は ${userOptions.minQueryLength} 文字以上で実行されます`);
    return;
  }
  setPopupHeight(userOptions.popupHeight || 600);
  // 空でない場合はバッジを表示（再表示）
  ["count-all", "count-bookmarks", "count-history"].forEach(id => {
    document.getElementById(id).style.display = "inline-block";
  });
  if (normalizedQuery === "") return;
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
          countBookmarks = renderBookmarks(nodes, keywords, matchFn, resultsAll, resultsBookmarks);
          countHistory = renderHistory(grouped, keywords, matchFn, resultsAll, resultsHistory);
          countAll = countBookmarks + countHistory;
          updateBadgeAndMessages(countAll, countBookmarks, countHistory);
        });
      } else {
        countHistory = renderHistory(grouped, keywords, matchFn, resultsAll, resultsHistory);
        countAll = countHistory;
        updateBadgeAndMessages(countAll, 0, countHistory);
      }
    });
  } else if (userOptions.searchTarget === "bookmarks") {
    chrome.bookmarks.getTree((nodes) => {
      countBookmarks = renderBookmarks(nodes, keywords, matchFn, resultsAll, resultsBookmarks);
      countAll = countBookmarks;
      updateBadgeAndMessages(countAll, countBookmarks, 0);
    });
  }
}

function collectBookmarks(nodes, result, path = []) {
  for (let node of nodes) {
    if (node.url) {
      result.push({
        ...node,
        folderPath: [...path] // フォルダ情報を保持
      });
    } else if (node.children) {
      collectBookmarks(node.children, result, [...path, node.title]);
    }
  }
}
function formatElapsedTime(ms) {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}日前`;
  if (hours > 0) return `${hours}時間前`;
  if (minutes > 0) return `${minutes}分前`;
  return `たった今`;
}
function updateSelection(items) {
  items.forEach((item, index) => {
    item.classList.toggle("selected", index === currentSelectedIndex);
  });

  // 自動スクロール調整
  const selected = items[currentSelectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
function getOriginOrSchemeHost(url) {
  try {
    const u = new URL(url);

    // chrome:// や about: などの場合 origin が使えないため fallback
    if (u.origin === "null") {
      return `${u.protocol}//${u.hostname || u.pathname.split("/")[0]}`;
    }

    return u.origin;
  } catch {
    // 万一パースできなければそのまま
    return url;
  }
}
function toHiragana(str) {
  return str.replace(/[\u30a1-\u30f6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}
function normalizeForSearch(str) {
  return str
    .normalize("NFKC")                       // 全角英数字・記号 → 半角
    .toLowerCase()                          // 大文字→小文字
    .replace(/[\u30a1-\u30f6]/g, ch =>      // カタカナ → ひらがな
      String.fromCharCode(ch.charCodeAt(0) - 0x60)
    )
    .replace(/\s+/g, " ")                   // 空白を統一
    .trim();
}
function normalizeForSearch(str) {
  return str
    .normalize("NFKC")                       // 全角英数字・記号 → 半角
    .toLowerCase()                          // 大文字→小文字
    .replace(/[\u30a1-\u30f6]/g, ch =>      // カタカナ → ひらがな
      String.fromCharCode(ch.charCodeAt(0) - 0x60)
    )
    .replace(/\s+/g, " ")                   // 空白を統一
    .trim();
}

function highlightKeywords(text, rawKeywords) {
  if (!rawKeywords?.length) return text;
  if (!userOptions.highlight) return text;

  const normalizedText = normalizeForSearch(text); // 正規化後の検索対象
  const highlightMap = new Array(text.length).fill(false);

  for (const raw of rawKeywords) {
    if (!raw) continue;
    const normKey = normalizeForSearch(raw);
    let start = 0;

    while (true) {
      const index = normalizedText.indexOf(normKey, start);
      if (index === -1) break;

      // 対応する元の位置をマーク（同じ長さと仮定）
      for (let i = index; i < index + normKey.length; i++) {
        highlightMap[i] = true;
      }
      start = index + normKey.length;
    }
  }

  // 元の text を走査して <mark> タグを挿入
  let result = '';
  let inMark = false;

  for (let i = 0; i < text.length; i++) {
    if (highlightMap[i] && !inMark) {
      result += '<mark>';
      inMark = true;
    } else if (!highlightMap[i] && inMark) {
      result += '</mark>';
      inMark = false;
    }
    result += text[i];
  }
  if (inMark) result += '</mark>';

  return result;
}
function applyTabVisibility(target) {
  const allTab = document.getElementById("tab-all");
  const bookmarksTab = document.getElementById("tab-bookmarks");
  const historyTab = document.getElementById("tab-history");

  // 初期化（全て表示）
  allTab.parentElement.style.display = "none";
  bookmarksTab.parentElement.style.display = "none";
  historyTab.parentElement.style.display = "none";

  // 対象だけ表示＆アクティブ
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

  ["all", "bookmarks", "history"].forEach(id => {
    const list = document.getElementById(`results-${id}`);
    list.classList.toggle("d-none", id !== targetId);
  });
  // 選択状態を更新  
  // selectedIndexMap[targetId] = -1;
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

function loadHistoryOnce(callback) {
  const now = Date.now();
  const isCacheValid = cachedHistory.length > 0 && (now - historyCacheTimestamp < HISTORY_CACHE_TTL_MS);

  if (isCacheValid) {
    callback(cachedHistory);
    console.log("キャッシュを使用", cachedHistory.length, "件 ", historyCacheTimestamp, "ms");
    return;
  }
  let startTime = 0;
  if (userOptions.historyPeriod !== "all") {
    startTime = now - parseInt(userOptions.historyPeriod) * 24 * 60 * 60 * 1000;
  }

  chrome.history.search({ text: "", maxResults: userOptions.historyMaxResults, startTime: startTime }, (results) => {
    cachedHistory = results;
    historyCacheTimestamp = Date.now(); // 新しいタイムスタンプ記録
    callback(results);
  });
}
function groupHistoryByUrl(results) {
  const grouped = {};
  historyVisitMap = {};

  for (const item of results) {
    const url = item.url;
    if (!grouped[url]) {
      grouped[url] = {
        ...item,
        visitCount: item.visitCount
      };
    } else {
      grouped[url].visitCount += item.visitCount;
    }

    if (!historyVisitMap[url]) {
      historyVisitMap[url] = item.visitCount;
    } else {
      historyVisitMap[url] += item.visitCount;
    }
  }

  return Object.values(grouped);
}
function renderBookmarks(nodes, keywords, matchFn, resultsAll, resultsBookmarks) {
  let count = 0;
  const bookmarks = [];
  collectBookmarks(nodes, bookmarks);
  for (let b of bookmarks) {
    const text = (b.title + " " + b.url).toLowerCase();
    
    if (matchFn(text)) {
      const li = document.createElement("li");
      li.className = "list-group-item";

      const folderLabel = b.folderPath && b.folderPath.length > 0
        ? `<span class="badge bg-secondary me-1">📁 ${b.folderPath.join(" / ")}</span>`
        : "";
      const visitCount = historyVisitMap[b.url] || 0;
      const historyBadge = visitCount > 0
        ? `<span class="badge bg-info text-dark me-1">${visitCount} 回表示</span>`
        : "";
      const favicon = `<img src="https://www.google.com/s2/favicons?sz=16&domain_url=${encodeURIComponent(b.url)}" class="me-1" />`;
      // ✅ HTMLに埋め込む
      const displayTitle = highlightKeywords(b.title, keywords);
      const displayURL = highlightKeywords(b.url, keywords); 
      li.innerHTML = `
        ${favicon}
        ${folderLabel}
        ${historyBadge}
        <a href="${b.url}" target="_blank">${displayTitle}</a>
        <div class="url-text text-muted small ms-4">${displayURL}</div>
      `;
      li.title = b.url;
      let liClone = li.cloneNode(true);
      liClone.addEventListener("click", (e) => {
        // aタグを直接クリックした場合は処理しない
        if (e.target.tagName.toLowerCase() === "a") return;
      
        const items = document.querySelectorAll("#resultsWrapper li");
        items.forEach(el => el.classList.remove("selected"));
        li.classList.add("selected");
      
        const link = li.querySelector("a");
        if (link) {
          window.open(link.href, "_blank");
        }
      });
      resultsBookmarks.appendChild(liClone);
      li.addEventListener("click", (e) => {
        // aタグを直接クリックした場合は処理しない
        if (e.target.tagName.toLowerCase() === "a") return;
      
        const items = document.querySelectorAll("#resultsWrapper li");
        items.forEach(el => el.classList.remove("selected"));
        li.classList.add("selected");
      
        const link = li.querySelector("a");
        if (link) {
          window.open(link.href, "_blank");
        }
      });
      resultsAll.appendChild(li);
      count++;
    }
  }
  return count;
}
function renderHistory(grouped, keywords, matchFn, resultsAll, resultsHistory) {
  let count = 0;
  for (let h of grouped) {
    const text = (h.title + " " + h.url).toLowerCase();
    if (matchFn(text)) {
      const li = document.createElement("li");
      li.className = "list-group-item";
      const favicon = `<img src="https://www.google.com/s2/favicons?sz=16&domain_url=${encodeURIComponent(h.url)}" class="me-1" />`;
      const elapsedTag = h.lastVisitTime
        ? `<span class="badge bg-primary me-1">${formatElapsedTime(h.lastVisitTime)}</span>`
        : "";
      const countBadge = h.visitCount > 0
        ? `<span class="badge bg-info text-dark me-1">${h.visitCount} 回表示</span>`
        : "";
      // ✅ HTMLに埋め込む
      const displayTitle = highlightKeywords(h.title, keywords);
      const displayURL = highlightKeywords(h.url, keywords); 
      li.innerHTML = `
        ${favicon}
        ${elapsedTag}
        ${countBadge} <!-- Added countBadge to HTML -->
        <a href="${h.url}" target="_blank">${displayTitle}</a>
        <div class="url-text text-muted small ms-4" title="${h.url}">${displayURL}</div>
      `;
      li.title = h.url;
      let liClone = li.cloneNode(true);
      liClone.addEventListener("click", (e) => {
        // aタグを直接クリックした場合は処理しない
        if (e.target.tagName.toLowerCase() === "a") return;
      
        const items = document.querySelectorAll("#resultsWrapper li");
        items.forEach(el => el.classList.remove("selected"));
        li.classList.add("selected");
      
        const link = li.querySelector("a");
        if (link) {
          window.open(link.href, "_blank");
        }
      });
      resultsHistory.appendChild(liClone);
      li.addEventListener("click", (e) => {
        // aタグを直接クリックした場合は処理しない
        if (e.target.tagName.toLowerCase() === "a") return;
      
        const items = document.querySelectorAll("#results li");
        items.forEach(el => el.classList.remove("selected"));
        li.classList.add("selected");
      
        const link = li.querySelector("a");
        if (link) {
          window.open(link.href, "_blank");
        }
      });
      resultsAll.appendChild(li);
      count++;
    }
  }
  return count;
}
function updateBadgeAndMessages(countAll, countBookmarks, countHistory) {
  document.getElementById("count-all").textContent = countAll;
  document.getElementById("count-bookmarks").textContent = countBookmarks;
  document.getElementById("count-history").textContent = countHistory;

  if (countAll === 0) {
    insertMessageItem(document.getElementById("results-all"), "一致する結果はありませんでした");
  }
  if (countBookmarks === 0) {
    insertMessageItem(document.getElementById("results-bookmarks"), "一致する結果はありませんでした");
  }
  if (countHistory === 0) {
    insertMessageItem(document.getElementById("results-history"), "一致する結果はありませんでした");
  }
}
