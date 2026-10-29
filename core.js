(function initModCore(globalScope) {
  const STORAGE_KEY = "modSets";

  function normalizeMethod(method) {
    return (method || "").trim().toUpperCase();
  }

  function getMatchMethods(match) {
    if (!match || typeof match !== "object") {
      return [];
    }

    if (Array.isArray(match.methods)) {
      return match.methods.map(normalizeMethod).filter(Boolean);
    }

    const single = normalizeMethod(match.method);
    return single ? [single] : [];
  }

  function parseRegexLiteral(input) {
    if (typeof input !== "string") {
      return null;
    }

    const trimmed = input.trim();
    if (!trimmed.startsWith("/") || trimmed.lastIndexOf("/") <= 0) {
      return null;
    }

    const lastSlash = trimmed.lastIndexOf("/");
    const pattern = trimmed.slice(1, lastSlash);
    const flags = trimmed.slice(lastSlash + 1);

    try {
      return new RegExp(pattern, flags);
    } catch (_err) {
      return null;
    }
  }

  function urlMatches(pattern, url) {
    if (!pattern || typeof pattern !== "string") {
      return false;
    }

    const asRegexLiteral = parseRegexLiteral(pattern);
    if (asRegexLiteral) {
      return asRegexLiteral.test(url);
    }

    return url.includes(pattern);
  }

  function requestMatches(modSet, url, method) {
    if (!modSet || !modSet.enabled || !modSet.match) {
      return false;
    }

    if (!urlMatches(modSet.match.urlPattern, url)) {
      return false;
    }

    const requiredMethods = getMatchMethods(modSet.match);
    if (requiredMethods.length === 0) {
      return true;
    }

    return requiredMethods.includes(normalizeMethod(method));
  }

  function getMatchingSets(modSets, url, method) {
    return (modSets || []).filter((set) => requestMatches(set, url, method));
  }

  function splitModsByKind(mods) {
    const result = {
      requestHeader: [],
      responseHeader: [],
      requestBody: [],
      responseBody: [],
      block: []
    };

    for (const mod of mods || []) {
      if (!mod || typeof mod !== "object") {
        continue;
      }

      switch (mod.type) {
        case "addRequestHeader":
        case "modifyRequestHeader":
          result.requestHeader.push(mod);
          break;
        case "addResponseHeader":
        case "modifyResponseHeader":
          result.responseHeader.push(mod);
          break;
        case "editRequestBody":
          result.requestBody.push(mod);
          break;
        case "editResponseBody":
          result.responseBody.push(mod);
          break;
        case "blockRequest":
          result.block.push(mod);
          break;
        default:
          break;
      }
    }

    return result;
  }

  function compileBodyMatcher(mod) {
    if (!mod || typeof mod.from !== "string") {
      return null;
    }

    if (mod.isRegex) {
      try {
        return new RegExp(mod.from, mod.regexFlags || "g");
      } catch (_err) {
        return null;
      }
    }

    return mod.from;
  }

  function applyBodyMods(text, mods) {
    if (typeof text !== "string" || !Array.isArray(mods) || mods.length === 0) {
      return text;
    }

    let next = text;

    for (const mod of mods) {
      const matcher = compileBodyMatcher(mod);
      if (!matcher) {
        continue;
      }

      const replacement = typeof mod.to === "string" ? mod.to : "";

      if (typeof matcher === "string") {
        next = next.split(matcher).join(replacement);
      } else {
        next = next.replace(matcher, replacement);
      }
    }

    return next;
  }

  function getHeaderValueFromHeaders(headers, name) {
    if (!headers || !name) {
      return null;
    }

    if (typeof headers.get === "function") {
      const value = headers.get(name);
      return value === null || value === undefined ? null : value;
    }

    if (Array.isArray(headers)) {
      const idx = findHeaderIndex(headers, name);
      return idx >= 0 ? String(headers[idx].value ?? "") : null;
    }

    if (typeof headers === "object") {
      const normalizedName = String(name).toLowerCase();
      const key = Object.keys(headers).find((k) => k.toLowerCase() === normalizedName);
      return key ? String(headers[key] ?? "") : null;
    }

    return null;
  }

  function valueMatchesPattern(pattern, value) {
    if (!pattern) {
      return true;
    }

    if (typeof value !== "string") {
      return false;
    }

    const asRegexLiteral = parseRegexLiteral(pattern);
    if (asRegexLiteral) {
      return asRegexLiteral.test(value);
    }

    return value.toLowerCase().includes(String(pattern).toLowerCase());
  }

  function modConditionMatches(mod, headers) {
    const condition = mod && mod.condition;
    const headerName = condition && String(condition.headerName || "").trim();
    if (!condition || !headerName) {
      return true;
    }

    const headerValue = getHeaderValueFromHeaders(headers, headerName);
    if (headerValue === null) {
      return false;
    }

    return valueMatchesPattern(condition.pattern, headerValue);
  }

  function findHeaderIndex(headers, name) {
    const normalizedName = String(name || "").toLowerCase();
    return headers.findIndex((h) => String(h.name || "").toLowerCase() === normalizedName);
  }

  function applyWebRequestHeaderMods(headers, mods) {
    const next = Array.isArray(headers) ? headers.slice() : [];

    for (const mod of mods || []) {
      const headerName = (mod.headerName || "").trim();
      if (!headerName) {
        continue;
      }

      const idx = findHeaderIndex(next, headerName);
      const value = String(mod.headerValue ?? "");

      if (mod.type === "addRequestHeader" || mod.type === "addResponseHeader") {
        if (idx === -1) {
          next.push({ name: headerName, value });
        }
      }

      if (mod.type === "modifyRequestHeader" || mod.type === "modifyResponseHeader") {
        if (idx >= 0) {
          const currentValue = String(next[idx].value ?? "");
          let nextValue = value;
          if (typeof mod.from === "string" && mod.from.length > 0) {
            nextValue = applyBodyMods(currentValue, [mod]);
          }

          next[idx] = { name: next[idx].name, value: nextValue };
        }
      }
    }

    return next;
  }

  function applyHeadersObjectMods(headers, mods, addType, modifyType) {
    const next = new Headers(headers || {});

    for (const mod of mods || []) {
      const headerName = (mod.headerName || "").trim();
      if (!headerName) {
        continue;
      }

      const headerValue = String(mod.headerValue ?? "");
      const exists = next.has(headerName);

      if (mod.type === addType && !exists) {
        next.append(headerName, headerValue);
      }

      if (mod.type === modifyType && exists) {
        if (typeof mod.from === "string" && mod.from.length > 0) {
          const currentValue = String(next.get(headerName) || "");
          const replaced = applyBodyMods(currentValue, [mod]);
          next.set(headerName, replaced);
        } else {
          next.set(headerName, headerValue);
        }
      }
    }

    return next;
  }

  function flattenModsFromSets(sets) {
    const mods = [];
    for (const set of sets || []) {
      const condition = (set.match && set.match.condition) || null;
      for (const mod of set.mods || []) {
        if (!mod || mod.enabled === false) {
          continue;
        }
        mods.push(condition ? { ...mod, condition } : mod);
      }
    }
    return mods;
  }

  globalScope.ModCore = {
    STORAGE_KEY,
    normalizeMethod,
    getMatchingSets,
    splitModsByKind,
    applyBodyMods,
    applyWebRequestHeaderMods,
    applyHeadersObjectMods,
    flattenModsFromSets,
    parseRegexLiteral,
    getHeaderValueFromHeaders,
    valueMatchesPattern,
    modConditionMatches
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
