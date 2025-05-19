chrome.storage.sync.get("theme", (data) => {
    const theme = data.theme || "auto";
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const appliedTheme =
        theme === "auto" ? (prefersDark ? "dark" : "light") : theme;
    document.documentElement.setAttribute("data-bs-theme", appliedTheme);
});
chrome.storage.sync.get(["popupWidth", "popupHeight"], (data) => {
    const w = data.popupWidth || 350;
    const h = data.popupHeight || 600;
    document.documentElement.style.width = `${w}px`;
    document.documentElement.style.height = `${h}px`;
});
