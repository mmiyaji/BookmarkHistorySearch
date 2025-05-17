document.getElementById("searchInput").focus();
document.getElementById("searchInput").addEventListener("input", runSearch);
// document.getElementById("openOptions").addEventListener("click", () => {
//   if (chrome.runtime.openOptionsPage) {
//     chrome.runtime.openOptionsPage();
//   } else {
//     // 古いバージョン対応
//     window.open(chrome.runtime.getURL("options.html"));
//   }
// });
let currentSelectedIndex = -1;
document.getElementById("searchInput").addEventListener("keydown", (e) => {
  const items = document.querySelectorAll("#results li");

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (items.length === 0) return;
    currentSelectedIndex = (currentSelectedIndex + 1) % items.length;
    updateSelection(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (items.length === 0) return;
    currentSelectedIndex = (currentSelectedIndex - 1 + items.length) % items.length;
    updateSelection(items);
  } else if (e.key === "Enter") {
    if (currentSelectedIndex >= 0 && items[currentSelectedIndex]) {
      const link = items[currentSelectedIndex].querySelector("a");
      if (link) window.open(link.href, "_blank");
    }
  }
});

let userOptions = {
  searchMode: "and",
  searchTarget: "both"
};
chrome.storage.sync.get(["searchMode", "searchTarget"], (data) => {
  userOptions = {
    searchMode: data.searchMode || "and",
    searchTarget: data.searchTarget || "both"
  };
  runSearch(); // 初回検索実行
});

function runSearch() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const results = document.getElementById("results");
  const hitCountEl = document.getElementById("hitCount");
  results.innerHTML = "";
  hitCountEl.textContent = "";
  currentSelectedIndex = -1;

  if (query === "") return;
  const keywords = query.split(/\s+/);

  const matchFn = (text) =>
    userOptions.searchMode === "and"
      ? keywords.every(k => text.includes(k))
      : keywords.some(k => text.includes(k));

  let hitCount = 0;
  if (userOptions.searchTarget === "bookmarks" || userOptions.searchTarget === "both") {
    chrome.bookmarks.getTree((nodes) => {
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
          const favicon = `<img src="https://www.google.com/s2/favicons?sz=16&domain_url=${encodeURIComponent(b.url)}" class="me-1" />`;
          // ✅ HTMLに埋め込む
          li.innerHTML = `
            ${favicon}
            ${folderLabel}
            <a href="${b.url}" target="_blank">${b.title}</a>
            <div class="url-text text-muted small ms-4">${b.url}</div>
          `;
          li.title = b.url;
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
          results.appendChild(li);
          hitCount++;
        }
      }
      hitCountEl.textContent = `${hitCount} 件ヒットしました`;
    });
  }
  if (userOptions.searchTarget === "history" || userOptions.searchTarget === "both") {    
    chrome.history.search({ text: "", maxResults: 300 }, (historyResults) => {
      for (let h of historyResults) {
        const text = (h.title + " " + h.url).toLowerCase();
        if (matchFn(text)) {
          const li = document.createElement("li");
          li.className = "list-group-item";
          const favicon = `<img src="https://www.google.com/s2/favicons?sz=16&domain_url=${encodeURIComponent(h.url)}" class="me-1" />`;
          const elapsedTag = h.lastVisitTime
            ? `<span class="badge bg-info me-1">${formatElapsedTime(h.lastVisitTime)}</span>`
            : "";
          // ✅ HTMLに埋め込む
          li.innerHTML = `
            ${favicon}
            ${elapsedTag}
            <a href="${h.url}" target="_blank">${h.title}</a>
            <div class="url-text text-muted small ms-4" title="${h.url}">${h.url}</div>
          `;
          li.title = h.url;
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
          results.appendChild(li);
          hitCount++;
        }
      }
      hitCountEl.textContent = `${hitCount} 件ヒットしました`;
    });
  }
}

// // 再帰的に全てのブックマークを取得する関数
// function collectBookmarks(nodes, result) {
//   for (let node of nodes) {
//     if (node.url) {
//       result.push(node);
//     } else if (node.children) {
//       collectBookmarks(node.children, result);
//     }
//   }
// }
// function collectBookmarks(nodes, result, path = []) {
//   for (let node of nodes) {
//     if (node.url) {
//       // "ブックマーク バー" / "Bookmarks Bar" のパスを除外
//       const displayPath = path.filter(p => !["ブックマーク バー", "Bookmarks Bar"].includes(p));
//       result.push({
//         ...node,
//         folderPath: displayPath
//       });
//     } else if (node.children) {
//       collectBookmarks(node.children, result, [...path, node.title]);
//     }
//   }
// }
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
