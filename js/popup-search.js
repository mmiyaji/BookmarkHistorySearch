const PopupSearch = (() => {
  const FIELD_PREFIXES = ["site", "title", "url"];
  const MAX_REGEX_LENGTH = 200;
  // Rejects classic catastrophic-backtracking shapes such as (a+)+ or (a*)*.
  const LITERAL_REGEX_ATOMS = /\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]/g;
  const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)[+*{]/;
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  function foldForSearch(str) {
    return str
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  }

  function normalizeForSearch(str) {
    return foldForSearch(str).replace(/\s+/g, " ").trim();
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
      if (rawQuery.length > MAX_REGEX_LENGTH || NESTED_QUANTIFIER_RE.test(rawQuery.replace(LITERAL_REGEX_ATOMS, "_"))) {
        return { fn: null, includeKeywords: [], excludeKeywords: [], error: "pattern too complex" };
      }
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
      const hasPeriodMetrics = items.some((item) => item.visitMetricsComplete === true || Number.isFinite(item.periodVisitCount));
      const hasMetricAttempts = items.some((item) => item.visitMetricsAttempted === true);
      if (!hasPeriodMetrics && !hasMetricAttempts) {
        return [...items].sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0));
      }
      return [...items].sort((a, b) => {
        const aComplete = a.visitMetricsComplete === true || Number.isFinite(a.periodVisitCount);
        const bComplete = b.visitMetricsComplete === true || Number.isFinite(b.periodVisitCount);
        const completeDiff = Number(bComplete) - Number(aComplete);
        if (completeDiff !== 0) return completeDiff;
        if (!aComplete && !bComplete) return 0;
        return (b.periodVisitCount || 0) - (a.periodVisitCount || 0);
      });
    }
    if (sortOrder === "trend") {
      return [...items].sort((a, b) => {
        const aComplete = a.visitMetricsComplete === true || Number.isFinite(a.trendDelta);
        const bComplete = b.visitMetricsComplete === true || Number.isFinite(b.trendDelta);
        const completeDiff = Number(bComplete) - Number(aComplete);
        if (completeDiff !== 0) return completeDiff;
        if (!aComplete && !bComplete) return 0;
        const deltaDiff = (b.trendDelta || 0) - (a.trendDelta || 0);
        if (deltaDiff !== 0) return deltaDiff;
        return (b.recentVisitCount || 0) - (a.recentVisitCount || 0);
      });
    }
    if (sortOrder === "lastVisit") {
      return [...items].sort((a, b) => {
        const aTime = a.latestVisitTime || a.lastVisitTime || a.closedAt || 0;
        const bTime = b.latestVisitTime || b.lastVisitTime || b.closedAt || 0;
        return bTime - aTime;
      });
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

  // NFKD gives the original and composed text a common coordinate system.
  // Several original Jamo can form one grapheme; a single ㍿ can form four.
  function foldedSourceRanges(text, folded) {
    const composed = text.normalize("NFKC");
    if (composed === text && folded.length === text.length) return null;

    const decomposedRanges = [];
    let start = 0;
    for (const char of text) {
      const range = { start, end: start + char.length };
      for (let i = 0; i < char.normalize("NFKD").length; i++) decomposedRanges.push(range);
      start = range.end;
    }

    const ranges = [];
    let offset = 0;
    for (const { segment } of graphemes.segment(composed)) {
      const next = offset + segment.normalize("NFKD").length;
      const range = { start: decomposedRanges[offset].start, end: decomposedRanges[next - 1].end };
      // Use only the length here. The actual folded text retains context such
      // as the final sigma in Greek, which depends on the surrounding letters.
      const length = segment.toLowerCase().length;
      for (let i = 0; i < length; i++) ranges.push(range);
      offset = next;
    }
    return ranges;
  }

  // Returns [{ text, mark }] so callers can build DOM nodes without innerHTML.
  function highlightSegments(text, rawKeywords, highlightEnabled) {
    text = String(text ?? "");
    if (!rawKeywords?.length || !highlightEnabled) return [{ text, mark: false }];
    const folded = foldForSearch(text);
    const ranges = foldedSourceRanges(text, folded);
    const normalized = folded.replace(/\s+/g, " ");
    // Each collapsed run occupies one search offset, including leading space.
    const boundaries = normalized.length === folded.length ? null : [0];
    if (boundaries) {
      for (const match of folded.matchAll(/\s+|\S/g)) boundaries.push(match.index + match[0].length);
    }
    const highlightMap = new Array(text.length).fill(false);
    for (const raw of rawKeywords) {
      if (!raw) continue;
      const normKey = normalizeForSearch(raw);
      if (!normKey) continue;
      let index = normalized.indexOf(normKey);
      while (index !== -1) {
        const next = index + normKey.length;
        const begin = boundaries ? boundaries[index] : index;
        const end = boundaries ? boundaries[next] : next;
        highlightMap.fill(true, ranges ? ranges[begin].start : begin, ranges ? ranges[end - 1].end : end);
        index = normalized.indexOf(normKey, next);
      }
    }

    const segments = [];
    for (let i = 0; i < text.length; i++) {
      const last = segments[segments.length - 1];
      if (last && last.mark === highlightMap[i]) last.text += text[i];
      else segments.push({ text: text[i], mark: highlightMap[i] });
    }
    return segments;
  }

  function highlightKeywords(text, rawKeywords, highlightEnabled) {
    return highlightSegments(text, rawKeywords, highlightEnabled)
      .map((seg) => (seg.mark ? `<mark>${escapeHtml(seg.text)}</mark>` : escapeHtml(seg.text)))
      .join("");
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

  function findBookmarkResults(nodes, matchFn, isSafeUrl) {
    const all = [];
    collectBookmarks(nodes, all);
    return {
      matches: all.filter((bookmark) => isSafeUrl(bookmark.url) && matchFn(toSearchItem(bookmark))),
      urls: new Set(all.map((bookmark) => bookmark.url))
    };
  }

  function combineResultsByUrl(bookmarks, histories, bookmarkedUrls) {
    const rows = new Map();
    for (const bookmark of bookmarks) {
      if (!rows.has(bookmark.url)) {
        rows.set(bookmark.url, { ...bookmark, bookmark, isBookmarked: true });
      }
    }
    for (const history of histories) {
      const bookmark = rows.get(history.url)?.bookmark;
      rows.set(history.url, {
        ...history,
        title: bookmark?.title || history.title,
        bookmark,
        isBookmarked: Boolean(bookmark) || bookmarkedUrls.has(history.url)
      });
    }
    return Array.from(rows.values());
  }

  function collectHistoryMatches(grouped, matchFn, isSafeUrl) {
    return grouped.filter((historyItem) => isSafeUrl(historyItem.url) && matchFn(toSearchItem(historyItem)));
  }

  function buildHistoryVisitMap(results) {
    const visitMap = {};
    for (const item of results) {
      if (!item.url) continue;
      visitMap[item.url] = (visitMap[item.url] || 0) + (Number(item.visitCount) || 0);
    }
    return visitMap;
  }

  function buildHistoryMetricsMap(results) {
    const metricsMap = new Map();
    for (const item of results) {
      if (!item.url) continue;
      metricsMap.set(item.url, {
        visitCount: Number(item.visitCount) || 0,
        lastVisitTime: Number(item.lastVisitTime) || 0
      });
    }
    return metricsMap;
  }

  function groupHistoryByUrl(results) {
    const grouped = {};
    for (const item of results) {
      const url = item.url;
      if (!url) continue;
      if (!grouped[url]) {
        grouped[url] = { ...item, visitCount: Number(item.visitCount) || 0, sourceUrls: [url] };
      } else {
        grouped[url].visitCount += Number(item.visitCount) || 0;
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
        // Ignore only the query string. Ports and fragments may identify a
        // different app/page and therefore remain part of the grouping key.
        baseKey = (item.title || "") + "\0" + url.origin + url.pathname + url.hash;
      } catch {
        baseKey = (item.title || "") + "\0" + item.url;
      }

      const existing = mergeMap.get(baseKey);
      if (!existing) {
        mergeMap.set(baseKey, { ...item, sourceUrls: [...(item.sourceUrls || [item.url])] });
      } else {
        existing.visitCount += Number(item.visitCount) || 0;
        existing.sourceUrls = Array.from(new Set([
          ...(existing.sourceUrls || [existing.url]),
          ...(item.sourceUrls || [item.url])
        ].filter(Boolean)));
        if (item.lastVisitTime > existing.lastVisitTime) {
          existing.lastVisitTime = item.lastVisitTime;
          existing.url = item.url;
        }
      }
    }
    return Array.from(mergeMap.values());
  }

  function normalizeRecentlyClosedSessions(sessions) {
    const results = [];

    const pushTab = (tab, lastModified) => {
      if (!tab?.url) return;

      let domain = "";
      try {
        domain = new URL(tab.url).hostname;
      } catch {}

      const closedAt = Number(lastModified) > 0 ? Number(lastModified) * 1000 : 0;
      results.push({
        title: tab.title || "",
        url: tab.url,
        domain,
        site: domain,
        combined: `${tab.title || ""} ${tab.url} ${domain}`,
        visitCount: 0,
        lastVisitTime: 0,
        closedAt,
        isRecentlyClosed: true,
        sessionId: tab.sessionId || ""
      });
    };

    for (const entry of Array.isArray(sessions) ? sessions : []) {
      if (entry?.tab) {
        pushTab(entry.tab, entry.lastModified);
        continue;
      }
      if (entry?.window?.tabs) {
        for (const tab of entry.window.tabs) pushTab(tab, entry.lastModified);
      }
    }

    return results;
  }

  function mergeHistoryWithRecentlyClosed(historyItems, recentlyClosedItems) {
    const merged = new Map();

    for (const item of historyItems) {
      merged.set(item.url, { ...item, isRecentlyClosed: Boolean(item.isRecentlyClosed) });
    }

    for (const item of recentlyClosedItems) {
      const existing = merged.get(item.url);
      if (existing) {
        existing.isRecentlyClosed = true;
        existing.closedAt = Math.max(existing.closedAt || 0, item.closedAt || 0);
        existing.sessionId = item.sessionId || existing.sessionId || "";
      } else {
        merged.set(item.url, { ...item });
      }
    }

    return Array.from(merged.values()).sort((a, b) => {
      const aActivity = Math.max(a.lastVisitTime || 0, a.closedAt || 0);
      const bActivity = Math.max(b.lastVisitTime || 0, b.closedAt || 0);
      return bActivity - aActivity;
    });
  }

  function summarizeVisits(visits, nowMs = Date.now(), periodDays = 90) {
    const dayMs = 24 * 60 * 60 * 1000;
    const parsedPeriodDays = periodDays === "all" ? null : Number(periodDays);
    const periodStart = Number.isFinite(parsedPeriodDays) && parsedPeriodDays > 0
      ? nowMs - parsedPeriodDays * dayMs
      : Number.NEGATIVE_INFINITY;
    const recentStart = nowMs - 7 * dayMs;
    const previousStart = nowMs - 14 * dayMs;

    let periodVisitCount = 0;
    let periodLastVisitTime = 0;
    let latestVisitTime = 0;
    let recentVisitCount = 0;
    let previousVisitCount = 0;

    for (const visit of Array.isArray(visits) ? visits : []) {
      const visitTime = Number(visit?.visitTime);
      if (!Number.isFinite(visitTime) || visitTime > nowMs) continue;
      latestVisitTime = Math.max(latestVisitTime, visitTime);

      if (visitTime >= periodStart) {
        periodVisitCount += 1;
        periodLastVisitTime = Math.max(periodLastVisitTime, visitTime);
      }
      if (visitTime >= recentStart) {
        recentVisitCount += 1;
      } else if (visitTime >= previousStart) {
        previousVisitCount += 1;
      }
    }

    const trendScore = Math.log((recentVisitCount + 1) / (previousVisitCount + 1));
    return {
      visitMetricsAttempted: true,
      visitMetricsComplete: true,
      periodVisitCount,
      periodLastVisitTime,
      latestVisitTime,
      recentVisitCount,
      previousVisitCount,
      trendScore,
      trendDelta: recentVisitCount - previousVisitCount
    };
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

  function getDomainFacets(urls) {
    const countMap = {};
    for (const url of urls) {
      try {
        const domain = new URL(url).hostname;
        countMap[domain] = (countMap[domain] || 0) + 1;
      } catch {}
    }
    return countMap;
  }

  return {
    applyOpenTabsPriority,
    buildHistoryVisitMap,
    buildHistoryMetricsMap,
    buildMatchFn,
    combineResultsByUrl,
    findBookmarkResults,
    collectHistoryMatches,
    formatElapsedTime,
    getDomainFacets,
    groupHistoryByUrl,
    highlightKeywords,
    mergeHistoryWithRecentlyClosed,
    mergeSameTitleHistory,
    normalizeForSearch,
    normalizeRecentlyClosedSessions,
    sortItems,
    summarizeVisits
  };
})();
