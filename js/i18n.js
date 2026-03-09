const I18N = (() => {
  const SUPPORTED = ["en", "ja"];
  const STORAGE_KEY = "langOverride";
  let currentT = (k, f="") => f || k;

  function normalizeLocale(lang) {
    if (!lang) return "en";
    const l = lang.toLowerCase();
    if (l.startsWith("ja")) return "ja";
    return "en";
  }

  async function getLocale() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ [STORAGE_KEY]: "auto" }, (cfg) => {
        const override = cfg[STORAGE_KEY];
        if (override && override !== "auto") return resolve(override);

        const langs = navigator.languages?.length
          ? navigator.languages
          : [navigator.language || "en"];
        for (const lang of langs) {
          const norm = normalizeLocale(lang);
          if (SUPPORTED.includes(norm)) return resolve(norm);
        }
        resolve("en");
      });
    });
  }

  async function loadMessages(locale) {
    const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load messages: ${locale}`);
    return res.json();
  }

  function makeTranslator(messages) {
    return function t(key, fallback = "") {
      const entry = messages[key];
      return entry && entry.message ? entry.message : fallback || key;
    };
  }

  function applyToDom(t) {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      el.textContent = t(key, el.textContent);
    });
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      const mapStr = el.getAttribute("data-i18n-attr");
      if (!mapStr) return;
      mapStr.split(",").forEach((pair) => {
        const [attr, key] = pair.split("=").map((s) => s.trim());
        if (!attr || !key) return;
        el.setAttribute(attr, t(key, el.getAttribute(attr) || ""));
      });
    });
  }

  async function init() {
    const locale = await getLocale();
    const messages = await loadMessages(locale).catch(() => loadMessages("en"));
    const t = makeTranslator(messages);
    applyToDom(t);
    currentT = t;
    return t;
  }

  async function applyLocale(locale) {
    let loc = locale;
    if (!loc || loc === "auto") {
      loc = await getLocale();
    } else {
      // 正規化（ja-JPなどをjaへ）
      loc = normalizeLocale(loc);
    }
    const messages = await loadMessages(loc).catch(() => loadMessages("en"));
    const t = makeTranslator(messages);
    applyToDom(t);
    currentT = t;
    return t;
  }

  // 今使っている t を返す（必要なら）
  function t() { return currentT; }

  return { init, applyLocale, STORAGE_KEY, t };
})();