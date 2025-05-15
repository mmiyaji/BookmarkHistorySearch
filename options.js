document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get(["searchMode", "searchTarget"], (data) => {
    document.getElementById("searchMode").value = data.searchMode || "and";
    document.getElementById("searchTarget").value = data.searchTarget || "both";
  });

  document.getElementById("saveBtn").addEventListener("click", () => {
    const searchMode = document.getElementById("searchMode").value;
    const searchTarget = document.getElementById("searchTarget").value;

    chrome.storage.sync.set({ searchMode, searchTarget }, () => {
      document.getElementById("status").textContent = "保存しました！";
      setTimeout(() => document.getElementById("status").textContent = "", 2000);
    });
  });
});
