const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

// Load our scripts in the same order as the extension page. Tests invoke the
// page's handlers directly so Chrome storage failures can be injected reliably.
function loadPage(page, initial = {}) {
  const fields = new Map();
  function element(id) {
    if (!fields.has(id)) fields.set(id, {
      value: "", style: {}, dataset: {}, parentElement: { style: {} }, listeners: {},
      classList: { toggle() {}, contains() { return false; } },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      appendChild() {}, focus() {}, setAttribute() {}, getAttribute() { return ""; },
      reportValidity() { return false; }
    });
    return fields.get(id);
  }
  const document = Object.assign(element("document"), {
    documentElement: element("html"), getElementById: element,
    createElement: () => element(Symbol()), querySelectorAll: () => [], querySelector: () => null
  });
  const data = { ...initial };
  const writes = [];
  const runtime = { getURL: (url) => url };
  const storage = {
    failReads: false,
    get(keys, callback) {
      if (this.failReads) {
        runtime.lastError = { message: "simulated read failure" };
        try { callback(undefined); } finally { delete runtime.lastError; }
      } else callback({ ...data });
    },
    set(update, callback) {
      writes.push(update);
      Object.assign(data, update);
      callback?.();
    }
  };
  const chrome = {
    runtime, storage: { sync: storage, local: storage },
    tabs: { query() {} }, history: {}, sessions: {}
  };
  const context = vm.createContext({
    URL, document, chrome, navigator: { languages: ["ja"] },
    window: { matchMedia: () => ({ matches: false }) },
    console: { warn() {} }, setTimeout() {}, clearTimeout() {},
    fetch: async (url) => ({
      ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(root, url), "utf8"))
    })
  });
  const html = fs.readFileSync(path.join(root, page + ".html"), "utf8");
  for (const [, src] of html.matchAll(/<script defer src="([^"]+)"/g)) {
    if (src.endsWith(".min.js")) continue;
    vm.runInContext(fs.readFileSync(path.join(root, src), "utf8"), context, { filename: src });
  }
  return { run: (code) => vm.runInContext(code, context), element, document, data, writes, storage, chrome };
}

test("saved search mutations preserve the stored list after a failed read and recover on retry", () => {
  const keep = { id: "original", query: "keep" };
  const page = loadPage("popup", { savedSearches: [keep] });
  page.element("searchInput").value = "new search";
  page.storage.failReads = true;
  page.run("saveCurrentSearch(); deleteSavedSearch('original')");
  assert.equal(page.writes.length, 0);
  assert.deepEqual(page.data.savedSearches, [keep]);
  page.storage.failReads = false;
  page.run("saveCurrentSearch()");
  assert.deepEqual(Array.from(page.data.savedSearches, (item) => item.query), ["new search", "keep"]);
  page.run("deleteSavedSearch('original')");
  assert.deepEqual(Array.from(page.data.savedSearches, (item) => item.query), ["new search"]);
});

test("history search matches query variants before grouping and opens a matching URL", () => {
  const page = loadPage("popup");
  const older = "https://example.test/doc?id=100";
  const newer = "https://example.test/doc?id=200";
  page.chrome.history.search = (_, cb) => cb([
    { title: "Document", url: older, lastVisitTime: 10, visitCount: 1 },
    { title: "Document", url: newer, lastVisitTime: 20, visitCount: 2 }
  ]);
  page.chrome.sessions.getRecentlyClosed = (_, cb) => cb([]);
  page.run("userOptions.searchTarget = 'history'; finalizeSearchResults = (_, rows) => globalThis.rows = rows;");
  for (const [query, expectedUrl, count] of [
    ["url:id=100", older, 1], ["Document -url:id=200", older, 1], ["Document", newer, 3]
  ]) {
    page.element("searchInput").value = query;
    page.run("runSearch()");
    const rows = page.run("rows");
    assert.equal(rows.length, 1, query);
    assert.equal(rows[0].url, expectedUrl);
    assert.equal(rows[0].visitCount, count);
  }
});

test("Tab and Shift+Tab keep native focus traversal, and the search shortcut switches tabs", () => {
  const page = loadPage("popup");
  const input = page.element("searchInput");
  const tabs = ["all", "bookmarks", "history"].map((id) => page.element(id));
  let selected = 0;
  tabs.forEach((tab, index) => {
    tab.offsetParent = page.document;
    tab.classList.contains = () => selected === index;
    tab.click = () => { selected = index; };
  });
  page.document.querySelectorAll = (selector) => selector.includes(".nav-link") ? tabs : [];
  page.run("wireEvents()");
  for (const target of [input, page.element("editTitle"), page.element("domainCheckbox")]) {
    for (const shiftKey of [false, true]) {
      const event = { key: "Tab", shiftKey, target, preventDefault: () => assert.fail("Tab was intercepted") };
      target.listeners.keydown?.(event);
      page.document.listeners.keydown?.(event);
    }
  }
  for (const [key, expected] of [["ArrowRight", 1], ["ArrowLeft", 0], ["ArrowLeft", 2]]) {
    let prevented = false;
    input.listeners.keydown({ key, target: input, altKey: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(selected, expected);
  }
});

test("options refuse invalid page sizes and accept both boundaries", () => {
  const page = loadPage("options");
  page.run("setFormFields(DEFAULT_SETTINGS)");
  page.element("language").value = "auto";
  for (const value of ["-1", "9", "501", "10.5", ""]) {
    page.element("displayLimit").value = value;
    page.run("onSave()");
    assert.equal(page.writes.length, 0, value);
  }
  for (const value of [10, 11, 500]) {
    page.element("displayLimit").value = String(value);
    page.run("onSave()");
    assert.equal(page.data.displayLimit, value);
  }
});

test("popup and options recover invalid stored page sizes and accept older numeric strings", async () => {
  for (const [stored, expected] of [[-1, 50], ["500", 500], ["20x", 50], [99.5, 50]]) {
    const popup = loadPage("popup", { displayLimit: stored });
    await popup.run("bootstrap()");
    assert.equal(popup.run("userOptions.displayLimit"), expected);
    const options = loadPage("options", { displayLimit: stored });
    await options.document.listeners.DOMContentLoaded();
    assert.equal(Number(options.element("displayLimit").value), expected);
  }
});

test("both pages finish initialization in the default language after a storage read error", async () => {
  for (const name of ["popup", "options"]) {
    const page = loadPage(name);
    page.storage.failReads = true;
    if (name === "popup") await page.run("bootstrap()");
    else await page.document.listeners.DOMContentLoaded();
    assert.equal(page.run("t('ui_tab_all')"), "All");
    const handler = name === "popup" ? page.element("searchInput").listeners.input : page.element("saveBtn").listeners.click;
    assert.equal(typeof handler, "function");
  }
});
