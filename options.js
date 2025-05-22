const DEFAULT_SETTINGS = {
  searchMode: "and",
  searchTarget: "both",
  theme: "auto",
  popupWidth: 350,
  popupHeight: 600,
  highlight: true,
  historyMaxResults: 10000,
  historyPeriod: 90,
  minQueryLength: 2,
};

function setFormFields(data) {
  document.getElementById("searchMode").value = data.searchMode || DEFAULT_SETTINGS.searchMode;
  document.getElementById("searchTarget").value = data.searchTarget || DEFAULT_SETTINGS.searchTarget;
  document.getElementById("themeMode").value = data.theme || DEFAULT_SETTINGS.theme;
  document.getElementById("popupWidth").value = data.popupWidth || DEFAULT_SETTINGS.popupWidth;
  document.getElementById("popupHeight").value = data.popupHeight || DEFAULT_SETTINGS.popupHeight;
  document.getElementById("highlight").checked = data.highlight !== undefined ? data.highlight : DEFAULT_SETTINGS.highlight;
  document.getElementById("historyMaxResults").value = data.historyMaxResults || DEFAULT_SETTINGS.historyMaxResults;
  document.getElementById("historyPeriod").value = data.historyPeriod || DEFAULT_SETTINGS.historyPeriod;
  document.getElementById("minQueryLength").value = data.minQueryLength || DEFAULT_SETTINGS.minQueryLength;
  // テーマの適用
  applyTheme(data.theme || DEFAULT_SETTINGS.theme);
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (data) => {
    const mergedData = { ...DEFAULT_SETTINGS, ...data };
    setFormFields(mergedData);
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
  const popupWidth = document.getElementById("popupWidth").value;
  const popupHeight = document.getElementById("popupHeight").value;
  const highlight = document.getElementById("highlight").checked;
  const historyMaxResults = document.getElementById("historyMaxResults").value;
  const historyPeriod = document.getElementById("historyPeriod").value;
  const minQueryLength = document.getElementById("minQueryLength").value;
  // 入力値の検証
  if (!["and", "or"].includes(searchMode)) {
    document.getElementById("status").textContent = "検索モードは「and」または「or」のみです。";
    setTimeout(() => (document.getElementById("status").textContent = ""), 2000);
    return;
  }

  if (!["auto", "light", "dark"].includes(theme)) {
    document.getElementById("status").textContent = "テーマは「auto」「light」「dark」のいずれかです。";
    setTimeout(() => (document.getElementById("status").textContent = ""), 2000);
    return;
  }
  if (!["both", "bookmark", "history"].includes(searchTarget)) {
    document.getElementById("status").textContent = "検索対象は「both」「bookmark」「history」のいずれかです。";
    setTimeout(() => (document.getElementById("status").textContent = ""), 2000);
    return;
  }
  const isValidWidth = !isNaN(popupWidth) && popupWidth > 0;
  const isValidHeight = !isNaN(popupHeight) && popupHeight > 0;
  if (!isValidWidth || !isValidHeight) {
    document.getElementById("status").textContent = "幅と高さは正の数でなければなりません。";
    setTimeout(() => (document.getElementById("status").textContent = ""), 2000);
    return;
  }
  const isValidHistoryMaxResults = !isNaN(historyMaxResults) && historyMaxResults > 0;
  if (!isValidHistoryMaxResults) {
    document.getElementById("status").textContent = "履歴の最大結果数は正の数でなければなりません。";
    setTimeout(() => (document.getElementById("status").textContent = ""), 2000);
    return;
  }
  // 保存処理
  chrome.storage.sync.set({ 
    searchMode, 
    searchTarget, 
    theme, 
    popupWidth, 
    popupHeight, 
    highlight, 
    historyMaxResults, 
    historyPeriod, 
    minQueryLength, 
  }, () => {
    document.getElementById("status").textContent = "保存しました！";
    setTimeout(() => (document.getElementById("status").textContent = ""), 2000);
  });
});

// デフォルト値に戻す処理
document.getElementById("resetBtn").addEventListener("click", () => {
  setFormFields(DEFAULT_SETTINGS);
  document.getElementById("status").textContent = "デフォルト値に戻しました！(保存するには「設定を保存する」を押してください)";
  setTimeout(() => (document.getElementById("status").textContent = ""), 2000);
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
