const PopupSearch = (() => {
  const FIELD_PREFIXES = ["site", "title", "url"];

  function normalizeForSearch(str) {
    return str
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseStructuredToken(token) {
    const isExclude = token.startsWith("-");
    const raw = isExclude ? token.slice(1) : token;
    const colonIndex = raw.indexOf(":");
    if (colonIndex <= 0) {
      return { field: "text", value: raw, exclude: isExclude };
    }

    const field = raw.slice(0, colonIndex);
    const value = raw.slice(colonIndex + 1);
    if (!FIELD_PREFIXES.includes(field) || !value) {
      return { field: "text", value: raw, exclude: isExclude };
    }

    return { field, value, exclude: isExclude };
  }

  function buildFieldMatcher(searchMode, includeTokens, excludeTokens) {
    const normalizedIncludes = includeTokens
      .map((token) => ({ ...token, value: normalizeForSearch(token.value) }))
      .filter((token) => token.value);
    const normalizedExcludes = excludeTokens
      .map((token) => ({ ...token, value: normalizeForSearch(token.value) }))
      .filter((token) => token.value);

    const includeKeywords = normalizedIncludes.map((token) => token.value);

    const getFieldValue = (item, field) => {
      switch (field) {
        case "title":
          return normalizeForSearch(item.title || "");
        case "url":
          return normalizeForSearch(item.url || "");
        case "site":
          return normalizeForSearch(item.site || item.domain || "");
        default:
          return normalizeForSearch(item.combined || "");
      }
    };

    const tokenMatches = (item, token) => getFieldValue(item, token.field).includes(token.value);

    const fn = (item) => {
      const includeOk = searchMode === "and"
        ? normalizedIncludes.every((token) => tokenMatches(item, token))
        : normalizedIncludes.length === 0 || normalizedIncludes.some((token) => tokenMatches(item, token));
      const excludeOk = normalizedExcludes.every((token) => !tokenMatches(item, token));
      return includeOk && excludeOk;
    };

    return { fn, includeKeywords, excludeKeywords: normalizedExcludes.map((token) => token.value) };
  }

  function buildMatchFn(rawQuery, searchMode) {
    if (searchMode === "regex") {
      let regex;
      try {
        regex = new RegExp(rawQuery, "i");
      } catch (err) {
        return { fn: null, includeKeywords: [], excludeKeywords: [], error: err.message };
      }
      return { fn: (item) => regex.test(item.combined || ""), includeKeywords: [], excludeKeywords: [] };
    }

    const normalizedQuery = normalizeForSearch(rawQuery);
    const tokens = normalizedQuery.split(" ").filter(Boolean).map(parseStructuredToken);
    const includeTokens = tokens.filter((token) => !token.exclude && token.value);
    const excludeTokens = tokens.filter((token) => token.exclude && token.value);

    return buildFieldMatcher(searchMode, includeTokens, excludeTokens);
  }

  function sortItems(items, sortOrder) {
    if (sortOrder === "visitCount") {
      return [...items].sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0));
    }
    if (sortOrder === "lastVisit") {
      return [...items].sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));
    }
    if (sortOrder === "title") {
      return [...items].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    }
    return items;
  }

  function applyOpenTabsPriority(items, openTabUrls) {
    const open = items.filter((item) => openTabUrls.has(item.url));
    const rest = items.filter((item) => !openTabUrls.has(item.url));
    return [...open, ...rest];
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function highlightKeywords(text, rawKeywords, highlightEnabled) {
    if (!rawKeywords?.length || !highlightEnabled) return escapeHtml(text);
    const normalizedText = normalizeForSearch(text);
    const highlightMap = new Array(text.length).fill(false);
    for (const raw of rawKeywords) {
      if (!raw) continue;
      const normKey = normalizeForSearch(raw);
      if (!normKey) continue;
      let start = 0;
      while (true) {
        const index = normalizedText.indexOf(normKey, start);
        if (index === -1) break;
        for (let i = index; i < index + normKey.length; i++) highlightMap[i] = true;
        start = index + normKey.length;
      }
    }

    let result = "";
    let inMark = false;
    for (let i = 0; i < text.length; i++) {
      if (highlightMap[i] && !inMark) {
        result += "<mark>";
        inMark = true;
      } else if (!highlightMap[i] && inMark) {
        result += "</mark>";
        inMark = false;
      }
      result += escapeHtml(text[i]);
    }
    if (inMark) result += "</mark>";
    return result;
  }

  function collectBookmarks(nodes, result, path = []) {
    for (const node of nodes) {
      if (node.url) {
        result.push({ ...node, folderPath: [...path] });
      } else if (node.children) {
        collectBookmarks(node.children, result, [...path, node.title]);
      }
    }
  }

  function toSearchItem(item) {
    let domain = "";
    try {
      domain = new URL(item.url || "").hostname;
    } catch {}

    return {
      title: item.title || "",
      url: item.url || "",
      domain,
      site: domain,
      combined: `${item.title || ""} ${item.url || ""} ${domain}`
    };
  }

  function collectBookmarkMatches(nodes, matchFn, isSafeUrl) {
    const all = [];
    collectBookmarks(nodes, all);
    return all.filter((bookmark) => isSafeUrl(bookmark.url) && matchFn(toSearchItem(bookmark)));
  }

  function collectHistoryMatches(grouped, matchFn, isSafeUrl) {
    return grouped.filter((historyItem) => isSafeUrl(historyItem.url) && matchFn(toSearchItem(historyItem)));
  }

  function buildHistoryVisitMap(results) {
    const visitMap = {};
    for (const item of results) {
      visitMap[item.url] = (visitMap[item.url] || 0) + item.visitCount;
    }
    return visitMap;
  }

  function groupHistoryByUrl(results) {
    const grouped = {};
    for (const item of results) {
      const url = item.url;
      if (!grouped[url]) {
        grouped[url] = { ...item };
      } else {
        grouped[url].visitCount += item.visitCount;
        if (item.lastVisitTime > grouped[url].lastVisitTime) {
          grouped[url].lastVisitTime = item.lastVisitTime;
        }
      }
    }
    return Object.values(grouped);
  }

  function mergeSameTitleHistory(grouped) {
    const mergeMap = new Map();
    for (const item of grouped) {
      let baseKey;
      try {
        const url = new URL(item.url);
        baseKey = (item.title || "") + "\0" + url.protocol + "//" + url.hostname + url.pathname;
      } catch {
        baseKey = (item.title || "") + "\0" + item.url;
      }

      const existing = mergeMap.get(baseKey);
      if (!existing) {
        mergeMap.set(baseKey, { ...item });
      } else {
        existing.visitCount += item.visitCount;
        if (item.lastVisitTime > existing.lastVisitTime) {
          existing.lastVisitTime = item.lastVisitTime;
          existing.url = item.url;
        }
      }
    }
    return Array.from(mergeMap.values());
  }

  function formatElapsedTime(ms, tx, t) {
    const diff = Date.now() - ms;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return tx("ui_daysAgo", days);
    if (hours > 0) return tx("ui_hoursAgo", hours);
    if (minutes > 0) return tx("ui_minutesAgo", minutes);
    return t("ui_justNow");
  }

  function getDomainFacets(results) {
    const countMap = {};
    for (const item of results) {
      try {
        const domain = new URL(item.url).hostname;
        countMap[domain] = (countMap[domain] || 0) + 1;
      } catch {}
    }
    return countMap;
  }

  return {
    applyOpenTabsPriority,
    buildHistoryVisitMap,
    buildMatchFn,
    collectBookmarkMatches,
    collectHistoryMatches,
    formatElapsedTime,
    getDomainFacets,
    groupHistoryByUrl,
    highlightKeywords,
    mergeSameTitleHistory,
    normalizeForSearch,
    sortItems
  };
})();
