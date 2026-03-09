const LocaleConfig = (() => {
  const DEFAULT_LOCALE = "en";
  const STORAGE_KEY = "langOverride";
  const SUPPORTED_LOCALES = [
    { code: "en", label: "English", aliases: ["en"] },
    { code: "ja", label: "日本語", aliases: ["ja"] },
    { code: "fr", label: "Français", aliases: ["fr"] },
    { code: "es", label: "Español", aliases: ["es"] },
    { code: "de", label: "Deutsch", aliases: ["de"] },
    { code: "it", label: "Italiano", aliases: ["it"] },
    { code: "pt_BR", label: "Português (Brasil)", aliases: ["pt-br", "pt_br", "pt"] },
    { code: "zh_CN", label: "简体中文", aliases: ["zh-cn", "zh_cn", "zh-hans", "zh"] },
    { code: "zh_TW", label: "繁體中文", aliases: ["zh-tw", "zh_tw", "zh-hant"] },
    { code: "ko", label: "한국어", aliases: ["ko"] }
  ];

  function canonicalizeLocale(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/_/g, "-");
  }

  function findLocale(value) {
    const target = canonicalizeLocale(value);
    if (!target) return null;

    return SUPPORTED_LOCALES.find((locale) => {
      const candidates = [locale.code, ...(locale.aliases || [])].map(canonicalizeLocale);
      return candidates.includes(target);
    }) || null;
  }

  function normalizeLocale(lang) {
    const locale = findLocale(lang);
    if (locale) return locale.code;

    const base = canonicalizeLocale(lang).split("-")[0];
    const baseLocale = findLocale(base);
    if (baseLocale) return baseLocale.code;

    return DEFAULT_LOCALE;
  }

  function isSupportedLocale(locale) {
    return !!findLocale(locale);
  }

  function getSupportedLocales() {
    return SUPPORTED_LOCALES.map((locale) => ({ ...locale, aliases: [...(locale.aliases || [])] }));
  }

  function toHtmlLang(locale) {
    return normalizeLocale(locale).replace(/_/g, "-");
  }

  return {
    DEFAULT_LOCALE,
    STORAGE_KEY,
    getSupportedLocales,
    isSupportedLocale,
    normalizeLocale,
    toHtmlLang
  };
})();
