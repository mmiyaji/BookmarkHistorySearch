const ChromeApi = (() => {
  // Reads chrome.runtime.lastError so failures never surface as unchecked
  // errors, and hands callbacks a safe fallback value instead of undefined.
  function guard(callback, fallback) {
    return (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.warn("Chrome API error:", error.message);
        result = undefined;
      }
      if (callback) callback(result === undefined ? fallback() : result, error);
    };
  }

  function getSync(keys, callback) {
    chrome.storage.sync.get(keys, guard(callback, () => ({})));
  }

  function setSync(data, callback) {
    chrome.storage.sync.set(data, callback);
  }

  function getLocal(key, callback) {
    chrome.storage.local.get(key, guard(callback, () => ({})));
  }

  function setLocal(data, callback) {
    chrome.storage.local.set(data, callback);
  }

  function queryTabs(queryInfo, callback) {
    chrome.tabs.query(queryInfo, callback);
  }

  function getBookmarksTree(callback) {
    chrome.bookmarks.getTree(callback);
  }

  function removeBookmark(id, callback) {
    chrome.bookmarks.remove(id, callback);
  }

  function updateBookmark(id, changes, callback) {
    chrome.bookmarks.update(id, changes, callback);
  }

  function searchHistory(query, callback) {
    chrome.history.search(query, callback);
  }

  function getHistoryVisits(url, callback) {
    chrome.history.getVisits({ url }, callback);
  }

  function getRecentlyClosed(callback) {
    chrome.sessions.getRecentlyClosed({ maxResults: 25 }, callback);
  }

  return {
    getSync,
    setSync,
    getLocal,
    setLocal,
    queryTabs,
    getBookmarksTree,
    removeBookmark,
    updateBookmark,
    searchHistory,
    getHistoryVisits,
    getRecentlyClosed
  };
})();
