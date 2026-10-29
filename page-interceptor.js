(function initPageInterceptor() {
  const REQUEST_EVENT = "HTTP_MOD_SETS_REQUEST";
  const RESPONSE_EVENT = "HTTP_MOD_SETS_RESPONSE";
  const UPDATE_EVENT = "HTTP_MOD_SETS_UPDATE";

  let currentSets = [];

  function setSetsFromEvent(event) {
    const sets = event && event.detail && Array.isArray(event.detail.sets) ? event.detail.sets : [];
    currentSets = sets;
  }

  function requestInitialSets() {
    return new Promise((resolve) => {
      const handler = (event) => {
        window.removeEventListener(RESPONSE_EVENT, handler);
        setSetsFromEvent(event);
        resolve();
      };

      window.addEventListener(RESPONSE_EVENT, handler, { once: true });
      window.dispatchEvent(new CustomEvent(REQUEST_EVENT));
    });
  }

  function isTextualContentType(contentType) {
    if (!contentType) {
      return false;
    }

    const normalized = String(contentType).toLowerCase();
    return (
      normalized.includes("text/") ||
      normalized.includes("application/json") ||
      normalized.includes("application/javascript") ||
      normalized.includes("application/xml") ||
      normalized.includes("application/x-www-form-urlencoded")
    );
  }

  function getMatchingMods(url, method) {
    const matchingSets = ModCore.getMatchingSets(currentSets, url, method);
    return ModCore.flattenModsFromSets(matchingSets);
  }

  // Reading url/method without constructing a Request: building a Request from a
  // Request marks the original's body as used, which breaks the original call.
  function describeRequest(input, init) {
    if (input instanceof Request) {
      return {
        url: input.url,
        method: ((init && init.method) || input.method || "GET").toUpperCase()
      };
    }

    let url;
    try {
      url = new URL(String(input && input.url ? input.url : input), document.baseURI).href;
    } catch (_err) {
      url = String(input);
    }

    return { url, method: ((init && init.method) || "GET").toUpperCase() };
  }

  function hasBody(response) {
    return response.body !== null && response.status !== 204 && response.status !== 205 && response.status !== 304;
  }

  async function maybeEditRequestBody(request, bodyMods) {
    if (!bodyMods.length) {
      return { request, changed: false };
    }

    const method = (request.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") {
      return { request, changed: false };
    }

    try {
      const contentType = request.headers.get("content-type") || "";
      if (!isTextualContentType(contentType)) {
        return { request, changed: false };
      }

      const originalBody = await request.clone().text();
      const editedBody = ModCore.applyBodyMods(originalBody, bodyMods);
      if (editedBody === originalBody) {
        return { request, changed: false };
      }

      return { request: new Request(request, { body: editedBody }), changed: true };
    } catch (_err) {
      return { request, changed: false };
    }
  }

  function applyRequestHeaderMods(headers, mods) {
    return ModCore.applyHeadersObjectMods(headers, mods, "addRequestHeader", "modifyRequestHeader");
  }

  function applyResponseHeaderMods(headers, mods) {
    return ModCore.applyHeadersObjectMods(headers, mods, "addResponseHeader", "modifyResponseHeader");
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input, init) {
    const { url, method } = describeRequest(input, init);
    const mods = getMatchingMods(url, method);

    if (!mods.length) {
      return originalFetch(input, init);
    }

    let request;
    try {
      request = new Request(input, init);
    } catch (_err) {
      return originalFetch(input, init);
    }

    const grouped = ModCore.splitModsByKind(mods);

    // The network block rule stops this request. Send it unmodified so it fails natively and the
    // page's own rejection stays the page's, instead of an error thrown from extension code.
    if (grouped.block.some((mod) => ModCore.modConditionMatches(mod, request.headers))) {
      return originalFetch(request);
    }

    grouped.requestHeader = grouped.requestHeader.filter((mod) => ModCore.modConditionMatches(mod, request.headers));
    grouped.requestBody = grouped.requestBody.filter((mod) => ModCore.modConditionMatches(mod, request.headers));

    if (grouped.requestHeader.length > 0) {
      const nextHeaders = applyRequestHeaderMods(request.headers, grouped.requestHeader);
      request = new Request(request, { headers: nextHeaders });
    }

    const bodyEdit = await maybeEditRequestBody(request, grouped.requestBody);
    request = bodyEdit.request;

    // `input` may have been consumed by the constructors above — always send `request`.
    const response = await originalFetch(request);
    // Opaque and opaque-redirect responses carry status 0 and cannot be reconstructed.
    if (response.type === "opaque" || response.type === "opaqueredirect" || response.status === 0) {
      return response;
    }

    grouped.responseHeader = grouped.responseHeader.filter((mod) => ModCore.modConditionMatches(mod, response.headers));
    grouped.responseBody = grouped.responseBody.filter((mod) => ModCore.modConditionMatches(mod, response.headers));
    const nextResponseHeaders = applyResponseHeaderMods(response.headers, grouped.responseHeader);

    if (!grouped.responseBody.length || !hasBody(response)) {
      if (!grouped.responseHeader.length) {
        return response;
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: nextResponseHeaders
      });
    }

    try {
      const contentType = response.headers.get("content-type") || "";
      if (!isTextualContentType(contentType)) {
        return grouped.responseHeader.length
          ? new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers: nextResponseHeaders
            })
          : response;
      }

      const sourceText = await response.text();
      const editedText = ModCore.applyBodyMods(sourceText, grouped.responseBody);
      return new Response(editedText, {
        status: response.status,
        statusText: response.statusText,
        headers: nextResponseHeaders
      });
    } catch (_err) {
      return grouped.responseHeader.length
        ? new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: nextResponseHeaders
          })
        : response;
    }
  };

  window.addEventListener(UPDATE_EVENT, setSetsFromEvent);
  requestInitialSets();
})();
