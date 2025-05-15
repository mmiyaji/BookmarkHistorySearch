document.getElementById("searchInput").focus();
document.getElementById("searchInput").addEventListener("input", runSearch);
document.getElementById("openOptions").addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    // 古いバージョン対応
    window.open(chrome.runtime.getURL("options.html"));
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
            ${folderLabel}<br />
            ${favicon}
            <a href="${b.url}" target="_blank">${b.title}</a>
          `;
          results.appendChild(li);
          hitCount++;
        }
      }
      hitCountEl.textContent = `${hitCount} 件ヒットしました`;
    });
  }
  if (userOptions.searchTarget === "history" || userOptions.searchTarget === "both") {    
    chrome.history.search({ text: "", maxResults: 100 }, (historyResults) => {
      for (let h of historyResults) {
        const text = (h.title + " " + h.url).toLowerCase();
        if (matchFn(text)) {
          const li = document.createElement("li");
          li.className = "list-group-item";
          const favicon = `<img src="https://www.google.com/s2/favicons?sz=16&domain_url=${encodeURIComponent(h.url)}" class="me-1" />`;
          // ✅ HTMLに埋め込む
          li.innerHTML = `
            ${favicon}
            <a href="${h.url}" target="_blank">${h.title}</a>
          `;
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