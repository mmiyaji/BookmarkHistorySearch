// options.js
let t = (k, f) => f || k;

function setDocumentLanguage(locale) {
  document.documentElement.setAttribute("lang", LocaleConfig.toHtmlLang(locale));
}

const DEFAULT_SETTINGS = {
  searchMode: "and",
  searchTarget: "both",
  theme: "auto",
  popupWidth: 500,
  popupHeight: 600,
  highlight: true,
  groupSameTitle: true,
  historyMaxResults: 10000,
  historyPeriod: 90,
  minQueryLength: 2,
  langOverride: "auto",
  sortOrder: "default",
  displayLimit: 50,
  enableRecentSearches: true,
  showFavicons: true
};

function getLanguageOptions() {
  return [
    { value: "auto", label: t("opt_lang_auto") },
    ...LocaleConfig.getSupportedLocales().map((locale) => ({
      value: locale.code,
      label: locale.label
    }))
  ];
}

function renderLanguageOptions(selectedValue) {
  const langSel = document.getElementById("language");
  if (!langSel) return;

  const currentValue = selectedValue ?? langSel.value ?? DEFAULT_SETTINGS.langOverride;
  langSel.innerHTML = "";

  for (const option of getLanguageOptions()) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    if (option.value === currentValue) el.selected = true;
    langSel.appendChild(el);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  t = await I18N.init();
  renderLanguageOptions(DEFAULT_SETTINGS.langOverride);

  chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (data) => {
    const merged = { ...DEFAULT_SETTINGS, ...data };
    setFormFields(merged);
  });

  const langSel = document.getElementById("language");
  if (langSel) {
    langSel.addEventListener("change", async (e) => {
      const val = e.target.value;
      t = await I18N.applyLocale(val);
      renderLanguageOptions(val);
      const langAttr = (val === "auto") ? (navigator.languages?.[0] || navigator.language || LocaleConfig.DEFAULT_LOCALE) : val;
      setDocumentLanguage(langAttr);
    });
  }

  document.getElementById("themeMode").addEventListener("change", (e) => {
    applyTheme(e.target.value);
  });
  document.getElementById("saveBtn").addEventListener("click", onSave);
  document.getElementById("resetBtn").addEventListener("click", onReset);
});

function setFormFields(data) {
  document.getElementById("searchMode").value = data.searchMode;
  document.getElementById("searchTarget").value = data.searchTarget;
  document.getElementById("themeMode").value = data.theme;
  document.getElementById("popupWidth").value = data.popupWidth;
  document.getElementById("popupHeight").value = data.popupHeight;
  document.getElementById("highlight").checked = data.highlight;
  document.getElementById("groupSameTitle").checked = data.groupSameTitle;
  document.getElementById("historyMaxResults").value = data.historyMaxResults;
  document.getElementById("historyPeriod").value = data.historyPeriod;
  document.getElementById("minQueryLength").value = data.minQueryLength;
  setDocumentLanguage(data.langOverride || DEFAULT_SETTINGS.langOverride);
  renderLanguageOptions(data.langOverride || DEFAULT_SETTINGS.langOverride);
  document.getElementById("sortOrder").value = data.sortOrder || "default";
  document.getElementById("displayLimit").value = data.displayLimit || 50;
  document.getElementById("enableRecentSearches").checked = data.enableRecentSearches !== false;
  document.getElementById("showFavicons").checked = data.showFavicons !== false;
  applyTheme(data.theme);
}

function onSave() {
  const searchMode = document.getElementById("searchMode").value;
  const searchTarget = document.getElementById("searchTarget").value;
  const theme = document.getElementById("themeMode").value;
  const popupWidth = Number(document.getElementById("popupWidth").value);
  const popupHeight = Number(document.getElementById("popupHeight").value);
  const highlight = document.getElementById("highlight").checked;
  const groupSameTitle = document.getElementById("groupSameTitle").checked;
  const historyMaxResults = Number(document.getElementById("historyMaxResults").value);
  const historyPeriod = document.getElementById("historyPeriod").value;
  const minQueryLength = Number(document.getElementById("minQueryLength").value);
  const langOverride = document.getElementById("language").value;
  const sortOrder = document.getElementById("sortOrder").value;
  const displayLimit = Number(document.getElementById("displayLimit").value);
  const enableRecentSearches = document.getElementById("enableRecentSearches").checked;
  const showFavicons = document.getElementById("showFavicons").checked;

  if (!["and", "or", "regex"].includes(searchMode)) return flashStatus(t("opt_err_mode"), true);
  if (!["auto", "light", "dark"].includes(theme)) return flashStatus(t("opt_err_theme"), true);
  if (!["both", "bookmarks", "history"].includes(searchTarget)) return flashStatus(t("opt_err_target"), true);
  if (!Number.isFinite(popupWidth) || popupWidth <= 0 || !Number.isFinite(popupHeight) || popupHeight <= 0) {
    return flashStatus(t("opt_err_size"), true);
  }
  if (!Number.isFinite(historyMaxResults) || historyMaxResults <= 0) {
    return flashStatus(t("opt_err_histmax"), true);
  }
  if (!Number.isFinite(minQueryLength) || minQueryLength < 1) {
    return flashStatus(t("opt_err_minlen"), true);
  }
  if (!(langOverride === "auto" || LocaleConfig.isSupportedLocale(langOverride))) {
    return flashStatus(t("opt_err_lang"), true);
  }

  chrome.storage.sync.set({
    searchMode, searchTarget, theme,
    popupWidth, popupHeight, highlight, groupSameTitle,
    historyMaxResults, historyPeriod, minQueryLength,
    langOverride, sortOrder, displayLimit, enableRecentSearches, showFavicons
  }, () => {
    safeSendMessage({ type: "langChanged" });
    I18N.applyLocale(langOverride).then((tt) => { t = tt; });
    flashStatus(t("opt_saved"));
  });
}

function onReset() {
  setFormFields(DEFAULT_SETTINGS);
  flashStatus(t("opt_reset_done"));
}

function flashStatus(msg, isError = false) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.classList.toggle("text-success", !isError);
  el.classList.toggle("text-danger", isError);
  setTimeout(() => (el.textContent = ""), 2000);
}

function applyTheme(theme) {
  if (theme === "auto") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-bs-theme", prefersDark ? "dark" : "light");
  } else {
    document.documentElement.setAttribute("data-bs-theme", theme);
  }
}

function safeSendMessage(payload) {
  try {
    chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
  } catch {}
}
