const I18N = (() => {
  const STORAGE_KEY = LocaleConfig.STORAGE_KEY;
  let currentT = (key, fallback = "") => fallback || key;

  async function getLocale() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ [STORAGE_KEY]: "auto" }, (cfg) => {
        const override = cfg[STORAGE_KEY];
        if (override && override !== "auto") {
          return resolve(LocaleConfig.normalizeLocale(override));
        }

        const langs = navigator.languages?.length
          ? navigator.languages
          : [navigator.language || LocaleConfig.DEFAULT_LOCALE];

        for (const lang of langs) {
          const normalized = LocaleConfig.normalizeLocale(lang);
          if (LocaleConfig.isSupportedLocale(normalized)) {
            return resolve(normalized);
          }
        }

        resolve(LocaleConfig.DEFAULT_LOCALE);
      });
    });
  }

  async function loadMessages(locale) {
    const normalized = LocaleConfig.normalizeLocale(locale);
    const url = chrome.runtime.getURL(`_locales/${normalized}/messages.json`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load messages: ${normalized}`);
    return res.json();
  }

  function makeTranslator(messages) {
    return function translate(key, fallback = "") {
      const entry = messages[key];
      return entry && entry.message ? entry.message : fallback || key;
    };
  }

  function applyToDom(translate) {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      el.textContent = translate(key, el.textContent);
    });

    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      const mapStr = el.getAttribute("data-i18n-attr");
      if (!mapStr) return;

      mapStr.split(",").forEach((pair) => {
        const [attr, key] = pair.split("=").map((s) => s.trim());
        if (!attr || !key) return;
        el.setAttribute(attr, translate(key, el.getAttribute(attr) || ""));
      });
    });
  }

  async function init() {
    const locale = await getLocale();
    const messages = await loadMessages(locale).catch(() => loadMessages(LocaleConfig.DEFAULT_LOCALE));
    const translate = makeTranslator(messages);
    applyToDom(translate);
    currentT = translate;
    return translate;
  }

  async function applyLocale(locale) {
    const resolved = !locale || locale === "auto"
      ? await getLocale()
      : LocaleConfig.normalizeLocale(locale);

    const messages = await loadMessages(resolved).catch(() => loadMessages(LocaleConfig.DEFAULT_LOCALE));
    const translate = makeTranslator(messages);
    applyToDom(translate);
    currentT = translate;
    return translate;
  }

  function t() {
    return currentT;
  }

  return { init, applyLocale, STORAGE_KEY, t };
})();
