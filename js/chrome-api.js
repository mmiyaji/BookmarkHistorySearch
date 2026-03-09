const ChromeApi = (() => {
  function getSync(keys, callback) {
    chrome.storage.sync.get(keys, callback);
  }

  function getLocal(key, callback) {
    chrome.storage.local.get(key, callback);
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

  return {
    getSync,
    getLocal,
    setLocal,
    queryTabs,
    getBookmarksTree,
    removeBookmark,
    updateBookmark,
    searchHistory
  };
})();
