importScripts("core.js");

const api = typeof browser !== "undefined" ? browser : chrome;
const STORAGE_KEY = "modSets";

const DNR_RULE_ID_BASE = 1000;
const DNR_RULE_ID_MAX = 900000;
// Block rules must outrank every modifyHeaders rule, whose priority grows with rule count.
const DNR_BLOCK_RULE_PRIORITY = 1000000;

function getMatchMethods(match) {
  if (!match || typeof match !== "object") {
    return [];
  }

  if (Array.isArray(match.methods)) {
    return match.methods
      .map((m) => String(m || "").trim().toLowerCase())
      .filter(Boolean);
  }

  const single = String(match.method || "").trim().toLowerCase();
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
  return { pattern, flags };
}

function toDnrCondition(match) {
  const condition = {};

  const parsedRegex = parseRegexLiteral(match.urlPattern || "");
  if (parsedRegex) {
    condition.regexFilter = parsedRegex.pattern;
    condition.isUrlFilterCaseSensitive = !parsedRegex.flags.includes("i");
  } else {
    condition.urlFilter = String(match.urlPattern || "");
  }

  const methods = getMatchMethods(match);
  if (methods.length > 0) {
    condition.requestMethods = methods;
  }

  return condition;
}

function headerConditionToDnrValues(pattern) {
  const parsedRegex = parseRegexLiteral(pattern);
  if (parsedRegex) {
    const literal = parsedRegex.pattern.replace(/\\(.)/g, "$1");
    console.warn(
      "[HTTP Mod Sets] DNR header conditions don't support real regex; matching header value as a substring of the regex pattern.",
      { pattern }
    );
    return [`*${literal}*`];
  }

  return [`*${String(pattern || "")}*`];
}

function applySetConditionToDnrCondition(condition, setCondition, isRequest) {
  const headerName = String((setCondition && setCondition.headerName) || "").trim();
  if (!headerName) {
    return;
  }

  const headerCondition = {
    header: headerName,
    values: headerConditionToDnrValues(setCondition.pattern)
  };

  if (isRequest) {
    condition.requestHeaders = [headerCondition];
  } else {
    condition.responseHeaders = [headerCondition];
  }
}

// Include main_frame for best-effort request-header support on top-level navigations.
// Some headers (notably Cookie) are still restricted by Chrome MV3 policy.
const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other"
];

function getResourceTypesForMod(_mod) {
  return ALL_RESOURCE_TYPES;
}

function isHeaderModType(type) {
  return (
    type === "addRequestHeader" ||
    type === "modifyRequestHeader" ||
    type === "addResponseHeader" ||
    type === "modifyResponseHeader"
  );
}

function isBlockModType(type) {
  return type === "blockRequest";
}

function buildHeaderOperation(mod, isRequest) {
  if (mod.type === "addResponseHeader") {
    return "append";
  }

  if (mod.type === "addRequestHeader" && isRequest) {
    // Chrome MV3 DNR is stricter for request header operations; set is reliable.
    return "set";
  }

  return "set";
}

function getHeaderRuleValue(mod) {
  if (!mod || typeof mod !== "object") {
    return "";
  }

  if (mod.type === "modifyRequestHeader" || mod.type === "modifyResponseHeader") {
    if (typeof mod.to === "string") {
      return mod.to;
    }
  }

  if (typeof mod.headerValue === "string") {
    return mod.headerValue;
  }

  return String(mod.headerValue ?? "");
}

function buildDnrRulesFromSets(modSets) {
  const rules = [];
  let nextId = DNR_RULE_ID_BASE;
  let nextPriority = 1;

  for (const set of modSets || []) {
    if (!set || !set.enabled || !set.match || !set.match.urlPattern) {
      continue;
    }

    for (const mod of set.mods || []) {
      if (!mod || mod.enabled === false || (!isHeaderModType(mod.type) && !isBlockModType(mod.type))) {
        continue;
      }

      if (nextId > DNR_RULE_ID_MAX) {
        break;
      }

      if (isBlockModType(mod.type)) {
        const blockCondition = toDnrCondition(set.match);
        blockCondition.resourceTypes = ALL_RESOURCE_TYPES;
        applySetConditionToDnrCondition(blockCondition, set.match.condition, true);

        rules.push({
          id: nextId,
          priority: DNR_BLOCK_RULE_PRIORITY,
          action: { type: "block" },
          condition: blockCondition
        });

        nextId += 1;
        continue;
      }

      const header = String(mod.headerName || "").trim();
      if (!header) {
        continue;
      }

      const condition = toDnrCondition(set.match);
      condition.resourceTypes = getResourceTypesForMod(mod);
      const isRequest = mod.type === "addRequestHeader" || mod.type === "modifyRequestHeader";
      applySetConditionToDnrCondition(condition, set.match.condition, isRequest);
      if (isRequest && header.toLowerCase() === "cookie") {
        console.warn(
          "[HTTP Mod Sets] Cookie request-header rewrite is limited/blocked in Chrome MV3 DNR and may not take effect.",
          { setName: set.name, header }
        );
      }

      const operation = buildHeaderOperation(mod, isRequest);
      const headerInfo = {
        header,
        operation,
        value: getHeaderRuleValue(mod)
      };
      const action = {
        type: "modifyHeaders"
      };
      if (isRequest) {
        action.requestHeaders = [headerInfo];
      } else {
        action.responseHeaders = [headerInfo];
      }

      rules.push({
        id: nextId,
        priority: nextPriority,
        action,
        condition
      });

      nextId += 1;
      nextPriority += 1;
    }
  }

  return rules;
}

async function loadSets() {
  const result = await api.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

function getDynamicRules() {
  return new Promise((resolve, reject) => {
    api.declarativeNetRequest.getDynamicRules((rules) => {
      if (api.runtime.lastError) {
        reject(new Error(api.runtime.lastError.message));
        return;
      }

      resolve(rules || []);
    });
  });
}

function updateDynamicRules(payload) {
  return new Promise((resolve, reject) => {
    api.declarativeNetRequest.updateDynamicRules(payload, () => {
      if (api.runtime.lastError) {
        reject(new Error(api.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

async function syncDnrFromStorage() {
  if (!api.declarativeNetRequest) {
    return;
  }

  const sets = await loadSets();
  const addRules = buildDnrRulesFromSets(sets);
  const existing = await getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  await updateDynamicRules({ removeRuleIds, addRules });
}

// Toolbar badge: how many enabled sets match the tab's URL.
function countMatchingSets(sets, url) {
  if (typeof url !== "string" || !url.startsWith("http")) {
    return 0;
  }
  return ModCore.getMatchingSets(sets, url, "GET").length;
}

async function updateBadge(tab) {
  if (!tab || tab.id === undefined || !api.action) {
    return;
  }
  const count = countMatchingSets(await loadSets(), tab.url);
  await api.action.setBadgeText({ tabId: tab.id, text: count ? String(count) : "" });
}

async function updateActiveBadges() {
  const tabs = await api.tabs.query({ active: true });
  await Promise.all(tabs.map(updateBadge));
}

function startBadges() {
  if (!api.action || !api.tabs) {
    return;
  }
  api.action.setBadgeBackgroundColor({ color: "#2b7fc0" });
  api.tabs.onActivated.addListener(({ tabId }) => {
    api.tabs.get(tabId).then(updateBadge).catch(() => {});
  });
  api.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === "complete") {
      updateBadge(tab).catch(() => {});
    }
  });
  updateActiveBadges().catch(() => {});
}

function startDnrMode() {
  syncDnrFromStorage().catch((err) => {
    console.error("DNR sync failed on start:", err);
  });

  api.runtime.onInstalled.addListener(() => {
    syncDnrFromStorage().catch((err) => {
      console.error("DNR sync failed on install:", err);
    });
  });

  api.runtime.onStartup.addListener(() => {
    syncDnrFromStorage().catch((err) => {
      console.error("DNR sync failed on startup:", err);
    });
  });
}

api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) {
    return;
  }

  syncDnrFromStorage().catch((err) => {
    console.error("DNR sync failed on storage change:", err);
  });
  updateActiveBadges().catch(() => {});
});

startDnrMode();
startBadges();
