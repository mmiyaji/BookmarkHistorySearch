const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return this.element.className.split(/\s+/).filter(Boolean);
  }

  contains(name) {
    return this.values().includes(name);
  }

  add(...names) {
    this.element.className = Array.from(new Set([...this.values(), ...names])).join(" ");
  }

  remove(...names) {
    const removed = new Set(names);
    this.element.className = this.values().filter((name) => !removed.has(name)).join(" ");
  }

  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.contains(name) : Boolean(force);
    if (shouldAdd) this.add(name);
    else this.remove(name);
    return shouldAdd;
  }
}

function matchesSelector(element, selector) {
  if (selector === "a") return element.tagName === "A";

  const loadMoreMatch = selector.match(/^\.load-more-btn\[data-load-more="([^"]+)"\]$/);
  if (loadMoreMatch) {
    return element.classList.contains("load-more-btn")
      && element.dataset.loadMore === loadMoreMatch[1];
  }

  return false;
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.className = "";
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.textContent = "";
    this.innerHTML = "";
    this.title = "";
    this.href = "";
    this.target = "";
  }

  appendChild(child) {
    if (child?.isFragment) {
      for (const fragmentChild of [...child.children]) this.appendChild(fragmentChild);
      child.children.length = 0;
      return child;
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index !== -1) siblings.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (matchesSelector(child, selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (selector.startsWith(".") && current.classList.contains(selector.slice(1))) return current;
      current = current.parentElement;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement("html");
    this.selectorResults = new Map();
    this.listeners = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createDocumentFragment() {
    const fragment = new FakeElement("fragment");
    fragment.isFragment = true;
    return fragment;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  querySelectorAll(selector) {
    return this.selectorResults.get(selector) || [];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getElementById() {
    return null;
  }

  setSelectorResults(selector, elements) {
    this.selectorResults.set(selector, elements);
  }
}

function loadPopup() {
  const document = new FakeDocument();
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {} }
    }
  };
  const chromeApi = {};
  const context = vm.createContext({
    URL,
    Date,
    Map,
    Set,
    Promise,
    console,
    document,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    window: { open() {} },
    confirm: () => false,
    setTimeout,
    clearTimeout,
    chrome,
    ChromeApi: chromeApi,
    I18N: {},
    LocaleConfig: {}
  });

  const popupSearchPath = path.join(__dirname, "..", "js", "popup-search.js");
  const popupPath = path.join(__dirname, "..", "popup.js");
  vm.runInContext(fs.readFileSync(popupSearchPath, "utf8"), context, {
    filename: popupSearchPath
  });
  vm.runInContext(
    `${fs.readFileSync(popupPath, "utf8")}\n`
      + `;globalThis.__popupForTests = {\n`
      + `  addLoadMoreButton,\n`
      + `  createBookmarkLi,\n`
      + `  createHistoryLi,\n`
      + `  enrichItemsWithVisitMetrics,\n`
      + `  filterBookmarkItems,\n`
      + `  filterHistoryItems,\n`
      + `  sortItems: PopupSearch.sortItems,\n`
      + `  setOptions(options) { userOptions = { ...userOptions, ...options }; }\n`
      + `};`,
    context,
    { filename: popupPath }
  );

  context.__popupForTests.setOptions({
    highlight: false,
    showFavicons: false
  });
  return { api: context.__popupForTests, chrome, chromeApi, document };
}

function checkbox(dataset, checked = false) {
  const element = new FakeElement("input");
  Object.assign(element.dataset, dataset);
  element.checked = checked;
  return element;
}

test("createBookmarkLi assigns an unescaped URL to anchor.href", () => {
  const { api } = loadPopup();
  const url = "https://example.test/search?q=bookmarks&a=one&b=two#result";
  const item = api.createBookmarkLi({
    id: "bookmark-1",
    title: "Bookmark",
    url,
    folderPath: []
  }, []);

  assert.equal(item.querySelector("a").href, url);
});

test("createHistoryLi assigns an unescaped URL to anchor.href", () => {
  const { api } = loadPopup();
  const url = "https://example.test/search?q=history&a=one&b=two#result";
  const item = api.createHistoryLi({
    title: "History",
    url,
    visitCount: 1,
    lastVisitTime: 0
  }, []);

  assert.equal(item.querySelector("a").href, url);
});

test("bookmark and history rows put the title before metadata and keep actions together", () => {
  const { api } = loadPopup();
  const url = "https://example.test/guide";
  const item = { title: "Guide", url, folderPath: ["Research"], isRecentlyClosed: true, periodVisitCount: 2 };
  for (const [createRow, buttonClasses] of [
    [api.createBookmarkLi, ["edit-btn", "delete-btn", "copy-btn"]],
    [api.createHistoryLi, ["copy-btn"]]
  ]) {
    const [title, details, actions] = createRow(item, []).children;
    assert.equal(title.tagName, "A");
    assert.equal(title.href, url);
    assert.ok(title.classList.contains("result-title"));
    assert.ok(details.children.some(el => el.title === url));
    assert.ok(details.children.some(el => el.classList.contains("badge")));
    assert.ok(actions.classList.contains("item-actions"));
    assert.deepEqual(actions.children.map(el => el.className.split(" ")[0]), buttonClasses);

    const untitled = createRow({ url }, []);
    const link = untitled.children[0];
    assert.equal(link.textContent || link.innerHTML, url);
    assert.equal(untitled.children[1].children.length, 0);
  }
});

test("filterBookmarkItems returns no bookmarks when every domain or folder is unchecked", () => {
  const { api, document } = loadPopup();
  const bookmark = {
    title: "Bookmark",
    url: "https://example.test/page",
    folderPath: ["Docs"]
  };
  const domainFilter = checkbox({ domain: "example.test" });
  const folderFilter = checkbox({ folder: "Docs" }, true);

  document.setSelectorResults(
    "#domainFilters input[data-domain]",
    [domainFilter]
  );
  document.setSelectorResults(
    "#folderFilters input[data-folder]",
    [folderFilter]
  );

  // An empty domain selection must not be interpreted as "all domains".
  assert.equal(api.filterBookmarkItems([bookmark]).length, 0);

  domainFilter.checked = true;
  folderFilter.checked = false;
  // The same rule applies independently to an empty folder selection.
  assert.equal(api.filterBookmarkItems([bookmark]).length, 0);
});

test("filterHistoryItems returns no history when every domain is unchecked", () => {
  const { api, document } = loadPopup();
  document.setSelectorResults(
    "#domainFilters input[data-domain]",
    [checkbox({ domain: "example.test" })]
  );

  assert.equal(api.filterHistoryItems([{
    title: "History",
    url: "https://example.test/page"
  }]).length, 0);
});

test("addLoadMoreButton replaces only the existing button with the same key", () => {
  const { api, document } = loadPopup();
  const list = document.createElement("div");
  api.addLoadMoreButton(list, "bookmarks", () => {}, 10);
  const firstBookmarksButton = list.querySelector(
    '.load-more-btn[data-load-more="bookmarks"]'
  );
  api.addLoadMoreButton(list, "history", () => {}, 20);
  const historyButton = list.querySelector(
    '.load-more-btn[data-load-more="history"]'
  );
  api.addLoadMoreButton(list, "bookmarks", () => {}, 5);
  const replacementBookmarksButton = list.querySelector(
    '.load-more-btn[data-load-more="bookmarks"]'
  );

  assert.equal(list.children.length, 2);
  assert.notStrictEqual(replacementBookmarksButton, firstBookmarksButton);
  assert.equal(firstBookmarksButton.parentElement, null);
  assert.strictEqual(historyButton.parentElement, list);
  assert.strictEqual(replacementBookmarksButton.parentElement, list);
});

test("failed visit API measurements are not replaced by cumulative visit counts", async () => {
  const { api, chrome, chromeApi } = loadPopup();
  chromeApi.getHistoryVisits = (_url, callback) => {
    chrome.runtime.lastError = { message: "history API failed" };
    callback(undefined);
    chrome.runtime.lastError = null;
  };
  api.setOptions({ displayLimit: 50, historyPeriod: 7, sortOrder: "visitCount" });

  const histories = [
    {
      id: "failed-low",
      title: "Low lifetime count",
      url: "https://low.example/page",
      sourceUrls: ["https://low.example/page"],
      visitCount: 1,
      lifetimeVisitCount: 1,
      visitMetricsAttempted: true
    },
    {
      id: "failed-high",
      title: "High lifetime count",
      url: "https://high.example/page",
      sourceUrls: ["https://high.example/page"],
      visitCount: 10_000,
      lifetimeVisitCount: 10_000,
      visitMetricsAttempted: true
    }
  ];

  const result = await api.enrichItemsWithVisitMetrics([], histories);
  const enriched = Array.from(result.histories);
  assert.equal(result.metricsLimited, true);
  assert.equal(result.analyzedUrlCount, 0);
  assert.equal(Object.hasOwn(enriched[0], "periodVisitCount"), false);
  assert.equal(Object.hasOwn(enriched[1], "periodVisitCount"), false);
  assert.deepEqual(
    Array.from(api.sortItems(enriched, "visitCount"), (item) => item.id),
    ["failed-low", "failed-high"]
  );
});

test("visit metrics are shared with matching results outside the candidate limit", async () => {
  const { api, chromeApi } = loadPopup();
  chromeApi.getHistoryVisits = (_url, callback) => callback([{ visitTime: Date.now() - 1_000 }]);
  api.setOptions({ displayLimit: 50, historyPeriod: 7 });
  const sharedUrl = "https://shared.example/page";
  const histories = Array.from({ length: 130 }, (_, index) => ({
    id: `history-${index}`,
    url: index === 129 ? sharedUrl : `https://history-${index}.example/page`,
    sourceUrls: [index === 129 ? sharedUrl : `https://history-${index}.example/page`],
    visitCount: 1
  }));
  const result = await api.enrichItemsWithVisitMetrics([{
    id: "bookmark-shared", url: sharedUrl, sourceUrls: [sharedUrl]
  }], histories);

  assert.equal(result.bookmarks[0].periodVisitCount, 1);
  assert.equal(Object.hasOwn(result.histories[129], "periodVisitCount"), true);
  assert.equal(result.histories[129].periodVisitCount, 1);
  assert.equal(result.analyzedUrlCount, 100);
});

test("duplicate bookmarks share measurements and grouped sources require complete success", async () => {
  const { api, chrome, chromeApi } = loadPopup();
  const calls = [];
  chromeApi.getHistoryVisits = (url, callback) => {
    calls.push(url);
    if (url.includes("fail")) {
      chrome.runtime.lastError = { message: "history API failed" };
      callback(undefined);
      chrome.runtime.lastError = null;
    } else {
      callback([{ visitTime: Date.now() - 1_000 }]);
    }
  };
  api.setOptions({ displayLimit: 50, historyPeriod: 7 });
  const sharedUrl = "https://shared.example/page";
  const result = await api.enrichItemsWithVisitMetrics([
    { id: "grouped", url: sharedUrl, sourceUrls: [sharedUrl, "https://fail.example/page"] },
    ...Array.from({ length: 101 }, (_, index) => ({
      id: `bookmark-${index}`, url: sharedUrl, sourceUrls: [sharedUrl]
    }))
  ], []);

  assert.deepEqual(calls.sort(), [sharedUrl, "https://fail.example/page"].sort());
  assert.equal(Object.hasOwn(result.bookmarks[0], "periodVisitCount"), false);
  assert.equal(result.bookmarks.slice(1).every((item) => item.periodVisitCount === 1), true);
});

test("visit metric requests stay within the 200 URL budget", async () => {
  const { api, chromeApi } = loadPopup();
  const requested = [];
  chromeApi.getHistoryVisits = (url, callback) => { requested.push(url); callback([]); };
  api.setOptions({ displayLimit: 250 });
  const bookmarks = Array.from({ length: 250 }, (_, index) => ({
    url: `https://budget-${index}.example/page`, sourceUrls: [`https://budget-${index}.example/page`]
  }));
  bookmarks.push({
    url: bookmarks[0].url,
    sourceUrls: [bookmarks[0].url, bookmarks[249].url]
  });

  const result = await api.enrichItemsWithVisitMetrics(bookmarks, []);
  assert.equal(requested.length, 200);
  assert.equal(result.analyzedUrlCount, 200);
  assert.equal(result.bookmarks.filter((item) => item.visitMetricsComplete).length, 200);
  assert.equal(Object.hasOwn(result.bookmarks[250], "periodVisitCount"), false);
  assert.equal(result.metricsLimited, true);
});

test("overlapping metric enrichments share the global six-request concurrency cap", async () => {
  const { api, chromeApi } = loadPopup();
  const callbacks = [];
  let active = 0;
  let maximumActive = 0;
  chromeApi.getHistoryVisits = (_url, callback) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    callbacks.push((visits = []) => { active -= 1; callback(visits); });
  };
  api.setOptions({ displayLimit: 20 });
  const makeItems = (prefix) => Array.from({ length: 20 }, (_, index) => ({
    url: `https://${prefix}-${index}.example/page`,
    sourceUrls: [`https://${prefix}-${index}.example/page`]
  }));
  let done = false;
  const first = api.enrichItemsWithVisitMetrics(makeItems("first"), []);
  const second = api.enrichItemsWithVisitMetrics(makeItems("second"), []);
  const combined = Promise.all([first, second]).then((results) => { done = true; return results; });
  let rounds = 0;
  while (!done && rounds < 1_000) {
    rounds += 1;
    callbacks.splice(0).forEach((release) => release());
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }
  assert.equal(done, true, "all held visit requests should settle");
  await combined;
  assert.equal(maximumActive, 6);
});

test("cancelled metric enrichment does not dispatch more queued API requests", async () => {
  const { api, chromeApi } = loadPopup();
  const callbacks = [];
  let shouldContinue = true;
  let calls = 0;
  chromeApi.getHistoryVisits = (_url, callback) => { calls += 1; callbacks.push(callback); };
  api.setOptions({ displayLimit: 20 });
  const items = Array.from({ length: 20 }, (_, index) => ({
    url: `https://cancel-${index}.example/page`,
    sourceUrls: [`https://cancel-${index}.example/page`]
  }));
  const pending = api.enrichItemsWithVisitMetrics(items, [], () => shouldContinue);
  shouldContinue = false;
  callbacks.splice(0).forEach((callback) => callback([]));
  const result = await pending;
  assert.equal(calls, 6);
  assert.equal(result.analyzedUrlCount, 0);
});
