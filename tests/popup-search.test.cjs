const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPopupSearch() {
  const sourcePath = path.join(__dirname, "..", "js", "popup-search.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const context = vm.createContext({
    Date,
    Map,
    Set,
    URL
  });

  vm.runInContext(
    `${source}\n;globalThis.__popupSearchForTests = PopupSearch;`,
    context,
    { filename: sourcePath }
  );

  return context.__popupSearchForTests;
}

const PopupSearch = loadPopupSearch();

test("combined results retain the matching bookmark identity and use history metrics only once", () => {
  const url = "https://example.test/doc";
  const nodes = [{ title: "Folder", children: [
    { id: "a", url, title: "Saved guide" },
    { id: "b", url, title: "Saved copy" },
    { id: "c", url: url + "?v=1", title: "Manual" }
  ] }];
  const { matches, urls } = PopupSearch.findBookmarkResults(nodes, item => item.title.includes("Saved"), () => true);
  const history = { url, title: "Visited guide", periodVisitCount: 7, trendDelta: 3 };
  const other = { url: url + "?v=1", title: "Saved edition", periodVisitCount: 8 };
  const rows = PopupSearch.combineResultsByUrl(matches, [history, other], urls);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bookmark.id, "a");
  assert.equal(rows[0].periodVisitCount, 7);
  assert.equal(rows[0].trendDelta, 3);
  assert.equal(PopupSearch.sortItems(rows, "visitCount")[0].url, other.url);
  assert.equal(rows[1].isBookmarked, true);
  assert.equal(rows[1].bookmark, undefined);
  const [filtered] = PopupSearch.combineResultsByUrl([matches[1]], [history], urls);
  assert.equal(filtered.bookmark.id, "b");
  assert.equal(history.title, "Visited guide");
});

function searchItem({ title = "", url = "", site = "" } = {}) {
  return {
    title,
    url,
    site,
    domain: site,
    combined: `${title} ${url} ${site}`
  };
}

test("sortItems keeps cumulative visitCount sorting for entirely legacy data", () => {
  const items = [
    { id: "low", visitCount: 1, lastVisitTime: 10 },
    { id: "missing" },
    { id: "high", visitCount: 8, lastVisitTime: 30 }
  ];

  const byVisits = PopupSearch.sortItems(items, "visitCount");
  const byLastVisit = PopupSearch.sortItems(items, "lastVisit");

  assert.deepEqual(Array.from(byVisits, (item) => item.id), ["high", "low", "missing"]);
  assert.deepEqual(Array.from(byLastVisit, (item) => item.id), ["high", "low", "missing"]);
  assert.deepEqual(items.map((item) => item.id), ["low", "missing", "high"]);
  assert.notStrictEqual(byVisits, items);
  assert.notStrictEqual(byLastVisit, items);
});

test("sortItems sorts titles and leaves the default order untouched", () => {
  const items = [
    { id: "z", title: "Zebra" },
    { id: "a", title: "Alpha" }
  ];

  assert.deepEqual(
    Array.from(PopupSearch.sortItems(items, "title"), (item) => item.id),
    ["a", "z"]
  );
  assert.strictEqual(PopupSearch.sortItems(items, "default"), items);
});

test("sortItems puts analyzed period counts before unanalyzed legacy counts", () => {
  const items = [
    { id: "legacy-high", visitCount: 10_000 },
    { id: "analyzed-zero", visitCount: 100, periodVisitCount: 0, visitMetricsComplete: true },
    { id: "analyzed-four", visitCount: 4, periodVisitCount: 4, visitMetricsComplete: true },
    { id: "period-present", visitCount: 2, periodVisitCount: 2 }
  ];

  assert.deepEqual(
    Array.from(PopupSearch.sortItems(items, "visitCount"), (item) => item.id),
    ["analyzed-four", "period-present", "analyzed-zero", "legacy-high"]
  );
});

test("sortItems does not fall back to cumulative counts after metric attempts fail", () => {
  const items = [
    { id: "failed-low", visitCount: 1, visitMetricsAttempted: true },
    { id: "failed-high", visitCount: 10_000, visitMetricsAttempted: true }
  ];

  assert.deepEqual(
    Array.from(PopupSearch.sortItems(items, "visitCount"), (item) => item.id),
    ["failed-low", "failed-high"]
  );
});

test("sortItems ranks complete trends by delta, then recent count, and ignores trendScore", () => {
  const items = [
    { id: "unanalyzed", trendScore: 100 },
    {
      id: "same-delta-fewer-recent",
      visitMetricsComplete: true,
      trendDelta: 2,
      recentVisitCount: 3,
      trendScore: 50
    },
    {
      id: "falling",
      visitMetricsComplete: true,
      trendDelta: -1,
      recentVisitCount: 20,
      trendScore: 1_000
    },
    {
      id: "same-delta-more-recent",
      visitMetricsComplete: true,
      trendDelta: 2,
      recentVisitCount: 5,
      trendScore: -100
    }
  ];

  assert.deepEqual(
    Array.from(PopupSearch.sortItems(items, "trend"), (item) => item.id),
    [
      "same-delta-more-recent",
      "same-delta-fewer-recent",
      "falling",
      "unanalyzed"
    ]
  );
});

test("normalizeForSearch applies NFKC, case folding, whitespace folding, and kana folding", () => {
  assert.equal(PopupSearch.normalizeForSearch("  ＡＰＩ　カタログ  "), "api かたろぐ");
});

test("buildMatchFn supports structured fields and exclusions", () => {
  const { fn, error } = PopupSearch.buildMatchFn(
    "title:ＡＰＩ site:EXAMPLE -url:archive",
    "and"
  );

  assert.equal(error, undefined);
  assert.equal(fn(searchItem({
    title: "API カタログ",
    url: "https://docs.example.test/current",
    site: "docs.example.test"
  })), true);
  assert.equal(fn(searchItem({
    title: "API カタログ",
    url: "https://docs.example.test/archive",
    site: "docs.example.test"
  })), false);
  assert.equal(fn(searchItem({
    title: "別の資料",
    url: "https://docs.example.test/current",
    site: "docs.example.test"
  })), false);
});

test("buildMatchFn implements OR matching while still applying every exclusion", () => {
  const { fn } = PopupSearch.buildMatchFn(
    "title:release site:example -url:private",
    "or"
  );

  assert.equal(fn(searchItem({
    title: "Release notes",
    url: "https://other.test/public",
    site: "other.test"
  })), true);
  assert.equal(fn(searchItem({
    title: "Unrelated",
    url: "https://example.test/public",
    site: "example.test"
  })), true);
  assert.equal(fn(searchItem({
    title: "Release notes",
    url: "https://example.test/private",
    site: "example.test"
  })), false);
});

test("buildMatchFn reports an invalid regular expression instead of throwing", () => {
  const result = PopupSearch.buildMatchFn("[", "regex");

  assert.equal(result.fn, null);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0);
});

test("mergeSameTitleHistory keeps otherwise identical URLs on different ports separate", () => {
  const merged = PopupSearch.mergeSameTitleHistory([
    {
      title: "Local app",
      url: "http://localhost:3000/dashboard#first",
      visitCount: 2,
      lastVisitTime: 100
    },
    {
      title: "Local app",
      url: "http://localhost:4000/dashboard#second",
      visitCount: 3,
      lastVisitTime: 200
    }
  ]);

  assert.equal(merged.length, 2);
  assert.deepEqual(
    Array.from(merged, (item) => item.url).sort(),
    [
      "http://localhost:3000/dashboard#first",
      "http://localhost:4000/dashboard#second"
    ]
  );
});

test("mergeSameTitleHistory keeps otherwise identical URLs with different hashes separate", () => {
  const merged = PopupSearch.mergeSameTitleHistory([
    {
      title: "Documentation",
      url: "https://example.test/guide#intro",
      visitCount: 2,
      lastVisitTime: 100
    },
    {
      title: "Documentation",
      url: "https://example.test/guide#advanced",
      visitCount: 3,
      lastVisitTime: 200
    }
  ]);

  assert.equal(merged.length, 2);
  assert.deepEqual(
    Array.from(merged, (item) => item.url).sort(),
    ["https://example.test/guide#advanced", "https://example.test/guide#intro"]
  );
});

test("mergeSameTitleHistory retains every source URL when query variants are grouped", () => {
  const olderUrl = "https://example.test/guide?version=1#intro";
  const newerUrl = "https://example.test/guide?version=2#intro";
  const [merged] = PopupSearch.mergeSameTitleHistory([
    {
      title: "Documentation",
      url: olderUrl,
      visitCount: 2,
      lastVisitTime: 100
    },
    {
      title: "Documentation",
      url: newerUrl,
      visitCount: 3,
      lastVisitTime: 200
    }
  ]);

  assert.equal(merged.visitCount, 5);
  assert.equal(merged.lastVisitTime, 200);
  assert.equal(merged.url, newerUrl);
  assert.deepEqual(Array.from(merged.sourceUrls).sort(), [newerUrl, olderUrl].sort());
});

test("summarizeVisits calculates period counts and fixed seven-day trend windows", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 7, 31, 12);
  const visits = [
    { visitTime: now - day },
    { visitTime: now - 3 * day },
    { visitTime: now - 6 * day },
    { visitTime: now - 8 * day }
  ];

  const summary = PopupSearch.summarizeVisits(visits, now, 30);

  assert.equal(summary.visitMetricsComplete, true);
  assert.equal(summary.periodVisitCount, 4);
  assert.equal(summary.periodLastVisitTime, now - day);
  assert.equal(summary.recentVisitCount, 3);
  assert.equal(summary.previousVisitCount, 1);
  assert.equal(summary.trendDelta, 2);
  assert.ok(Math.abs(summary.trendScore - Math.log(2)) < Number.EPSILON * 4);
});

test("summarizeVisits limits only period metrics to the selected period", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 7, 31, 12);
  const visits = [
    { visitTime: now - day },
    { visitTime: now - 5 * day },
    { visitTime: now - 9 * day },
    { visitTime: now - 40 * day }
  ];

  const summary = PopupSearch.summarizeVisits(visits, now, 7);

  assert.equal(summary.visitMetricsComplete, true);
  assert.equal(summary.periodVisitCount, 2);
  assert.equal(summary.periodLastVisitTime, now - day);
  assert.equal(summary.recentVisitCount, 2);
  assert.equal(summary.previousVisitCount, 1);
  assert.equal(summary.trendDelta, 1);
  assert.ok(Math.abs(summary.trendScore - Math.log(3 / 2)) < Number.EPSILON * 4);
});

test("summarizeVisits keeps the latest visit even when it is outside the selected period", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 7, 31, 12);
  const latestVisitTime = now - 40 * day;

  const summary = PopupSearch.summarizeVisits([
    { visitTime: now - 90 * day },
    { visitTime: latestVisitTime }
  ], now, 7);

  assert.equal(summary.periodVisitCount, 0);
  assert.equal(summary.periodLastVisitTime, 0);
  assert.equal(summary.latestVisitTime, latestVisitTime);
});

test("summarizeVisits uses inclusive period windows without double-counting boundaries", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 7, 31, 12);
  const sevenDayBoundary = now - 7 * day;
  const fourteenDayBoundary = now - 14 * day;

  const summary = PopupSearch.summarizeVisits([
    { visitTime: sevenDayBoundary },
    { visitTime: sevenDayBoundary - 1 },
    { visitTime: fourteenDayBoundary },
    { visitTime: fourteenDayBoundary - 1 },
    { visitTime: now + 1 }
  ], now, 7);

  assert.equal(summary.periodVisitCount, 1);
  assert.equal(summary.periodLastVisitTime, sevenDayBoundary);
  assert.equal(summary.latestVisitTime, sevenDayBoundary);
  assert.equal(summary.recentVisitCount, 1);
  assert.equal(summary.previousVisitCount, 2);
});

test("normalizeRecentlyClosedSessions uses the Chrome session timestamp for tabs", () => {
  const sessionTimeSeconds = 1_700_000_123;
  const [item] = PopupSearch.normalizeRecentlyClosedSessions([
    {
      lastModified: sessionTimeSeconds,
      tab: {
        title: "Closed tab",
        url: "https://example.test/closed",
        sessionId: "tab-session"
      }
    }
  ]);

  assert.equal(item.closedAt, sessionTimeSeconds * 1000);
  assert.equal(item.lastVisitTime, 0);
  assert.equal(item.sessionId, "tab-session");
});

test("normalizeRecentlyClosedSessions applies a window session timestamp to every tab", () => {
  const sessionTimeSeconds = 1_700_000_456;
  const items = PopupSearch.normalizeRecentlyClosedSessions([
    {
      lastModified: sessionTimeSeconds,
      window: {
        tabs: [
          { title: "One", url: "https://one.example/", sessionId: "one" },
          { title: "Two", url: "https://two.example/", sessionId: "two" }
        ]
      }
    }
  ]);

  assert.equal(items.length, 2);
  assert.deepEqual(
    Array.from(items, (item) => item.closedAt),
    [sessionTimeSeconds * 1000, sessionTimeSeconds * 1000]
  );
});

test("mergeHistoryWithRecentlyClosed keeps visit time and close time as separate facts", () => {
  const [merged] = PopupSearch.mergeHistoryWithRecentlyClosed(
    [{
      title: "Visited",
      url: "https://example.test/page",
      visitCount: 5,
      lastVisitTime: 1_000
    }],
    [{
      title: "Closed",
      url: "https://example.test/page",
      visitCount: 0,
      lastVisitTime: 0,
      closedAt: 2_000,
      sessionId: "recent-session",
      isRecentlyClosed: true
    }]
  );

  assert.equal(merged.lastVisitTime, 1_000);
  assert.equal(merged.closedAt, 2_000);
  assert.equal(merged.sessionId, "recent-session");
  assert.equal(merged.isRecentlyClosed, true);
});

test("regex complexity checks distinguish literal characters from quantifiers", () => {
  for (const pattern of [String.raw`([+])+`, String.raw`(\+)+`, String.raw`([\]*])+`]) {
    const { fn } = PopupSearch.buildMatchFn(pattern, "regex");
    assert.equal(typeof fn, "function", pattern);
    assert.equal(fn(searchItem({ title: "++**" })), true);
  }
  assert.equal(PopupSearch.buildMatchFn("([a-z]+)+", "regex").fn, null);
});

test("matched Unicode keywords highlight the corresponding original text", () => {
  for (const [original, query] of [
    ["한글", "한글"], ["ΟΣ", "ος"], ["ㅎㅏ", "하"], ["İ", "i\u0307"], ["ﾊﾞ", "ば"]
  ]) {
    const title = "  <" + original + "> ABC";
    const { fn, includeKeywords } = PopupSearch.buildMatchFn(query + " abc", "and");
    assert.equal(fn(searchItem({ title })), true, query);
    assert.equal(PopupSearch.highlightKeywords(title, includeKeywords, true),
      "  &lt;<mark>" + original + "</mark>&gt; <mark>ABC</mark>");
  }
  assert.equal(PopupSearch.highlightKeywords(" A \t B ", ["a b"], true), " <mark>A \t B</mark> ");
});
