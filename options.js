document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get(["searchMode", "searchTarget", "theme"], (data) => {
    document.getElementById("searchMode").value = data.searchMode || "and";
    document.getElementById("searchTarget").value = data.searchTarget || "both";
    const theme = data.theme || "auto";
    document.getElementById("themeMode").value = theme;
    applyTheme(theme);
  });
});

// テーマ変更時に即反映
document.getElementById("themeMode").addEventListener("change", (e) => {
  const theme = e.target.value;
  applyTheme(theme);
});

// 保存処理
document.getElementById("saveBtn").addEventListener("click", () => {
  const searchMode = document.getElementById("searchMode").value;
  const searchTarget = document.getElementById("searchTarget").value;
  const theme = document.getElementById("themeMode").value;

  chrome.storage.sync.set({ searchMode, searchTarget, theme }, () => {
    document.getElementById("status").textContent = "保存しました！";
    setTimeout(() => (document.getElementById("status").textContent = ""), 2000);
  });
});

// テーマ適用関数
function applyTheme(theme) {
  if (theme === "auto") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-bs-theme", prefersDark ? "dark" : "light");
  } else {
    document.documentElement.setAttribute("data-bs-theme", theme);
  }
}
