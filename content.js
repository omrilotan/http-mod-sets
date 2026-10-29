(function initBridgeAndInjection() {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const STORAGE_KEY = "modSets";
  const REQUEST_EVENT = "HTTP_MOD_SETS_REQUEST";
  const RESPONSE_EVENT = "HTTP_MOD_SETS_RESPONSE";
  const UPDATE_EVENT = "HTTP_MOD_SETS_UPDATE";

  async function loadSets() {
    const result = await api.storage.local.get(STORAGE_KEY);
    return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  }

  async function sendCurrentSets(eventName) {
    const sets = await loadSets();
    window.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { sets }
      })
    );
  }

  window.addEventListener(REQUEST_EVENT, () => {
    sendCurrentSets(RESPONSE_EVENT);
  });

  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) {
      return;
    }

    const sets = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
    window.dispatchEvent(
      new CustomEvent(UPDATE_EVENT, {
        detail: { sets }
      })
    );
  });

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "collectActivePageUrls") {
      return;
    }

    try {
      const urls = new Set();
      if (window.location && typeof window.location.href === "string") {
        urls.add(window.location.href);
      }

      if (window.performance && typeof window.performance.getEntriesByType === "function") {
        const resources = window.performance.getEntriesByType("resource");
        for (const entry of resources || []) {
          if (entry && typeof entry.name === "string" && entry.name.startsWith("http")) {
            urls.add(entry.name);
          }
        }
      }

      sendResponse({ ok: true, urls: Array.from(urls) });
    } catch (err) {
      sendResponse({ ok: false, error: String(err), urls: [] });
    }

    return true;
  });

  // core.js and page-interceptor.js run in the page's main world (see manifest); this only feeds them sets.
  sendCurrentSets(UPDATE_EVENT);
})();
