chrome.storage.sync.get("theme", (data) => {
    const theme = data.theme || "auto";
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const appliedTheme =
        theme === "auto" ? (prefersDark ? "dark" : "light") : theme;
    document.documentElement.setAttribute("data-bs-theme", appliedTheme);
});