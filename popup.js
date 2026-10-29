const api = typeof browser !== "undefined" ? browser : chrome;
const STORAGE_KEY = "modSets";
const COLLAPSED_KEY = "httpModSets.collapsed";
const SEARCH_THRESHOLD = 6;

const MOD_TYPES = [
  { value: "addRequestHeader", group: "Request", label: "Add header", short: "Req header +" },
  { value: "modifyRequestHeader", group: "Request", label: "Modify header", short: "Req header" },
  { value: "editRequestBody", group: "Request", label: "Edit body", short: "Req body" },
  { value: "blockRequest", group: "Request", label: "Block", short: "Block" },
  { value: "addResponseHeader", group: "Response", label: "Add header", short: "Res header +" },
  { value: "modifyResponseHeader", group: "Response", label: "Modify header", short: "Res header" },
  { value: "editResponseBody", group: "Response", label: "Edit body", short: "Res body" }
];

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const ICONS = {
  drag: '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>',
  chevron: '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
};

const setsContainer = document.getElementById("setsContainer");
const pageSummary = document.getElementById("pageSummary");
const newSetBtn = document.getElementById("newSetBtn");
const importBtn = document.getElementById("importBtn");
const exportBtn = document.getElementById("exportBtn");
const importFileInput = document.getElementById("importFileInput");
const importBanner = document.getElementById("importBanner");
const searchWrap = document.getElementById("searchWrap");
const searchInput = document.getElementById("searchInput");
const toast = document.getElementById("toast");

const state = {
  sets: [],
  activeUrls: [],
  activeHost: "",
  collapsed: loadCollapsed(),
  // Only one editor is open at a time:
  // { kind: "new-set" } | { kind: "set", setId } | { kind: "json", setId }
  // | { kind: "new-mod", setId } | { kind: "mod", setId, modId }
  editor: null,
  editorError: "",
  query: "",
  pendingImport: null
};

let undoSnapshot = null;
let toastTimer = null;

// ---------- markup helpers ----------

class Raw {
  constructor(value) {
    this.value = value;
  }
}

function raw(value) {
  return new Raw(value);
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toMarkup(value) {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  if (value instanceof Raw) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(toMarkup).join("");
  }
  return esc(value);
}

// Tagged template: interpolations are escaped unless wrapped in raw() or produced by html``.
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += toMarkup(values[i]) + strings[i + 1];
  }
  return raw(out);
}

function icon(name) {
  return raw(`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`);
}

// ---------- persistence ----------

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]"));
  } catch (_err) {
    return new Set();
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(state.collapsed)));
  } catch (_err) {
    // Collapse state is a convenience only.
  }
}

async function loadSets() {
  const result = await api.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function saveSets(sets) {
  await api.storage.local.set({ [STORAGE_KEY]: sets });
}

// Applies a mutation to the in-memory sets, persists, re-renders. Keeps one level of undo.
async function commit(mutate, undoMessage) {
  const snapshot = structuredClone(state.sets);
  mutate(state.sets);
  await saveSets(state.sets);
  if (undoMessage) {
    undoSnapshot = snapshot;
    showToast(undoMessage, true);
  }
  render();
}

// ---------- current page ----------

function normalizeUrls(urls) {
  return Array.from(new Set((urls || []).filter((u) => typeof u === "string" && u.startsWith("http"))));
}

async function getActiveTab() {
  if (!api.tabs || typeof api.tabs.query !== "function") {
    return null;
  }
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return (Array.isArray(tabs) && tabs[0]) || null;
}

async function collectUrlsFromTab(tabId) {
  try {
    const response = await api.tabs.sendMessage(tabId, { type: "collectActivePageUrls" });
    return response && response.ok && Array.isArray(response.urls) ? response.urls : [];
  } catch (_err) {
    return [];
  }
}

async function loadActivePage() {
  const tab = await getActiveTab();
  if (!tab) {
    return;
  }

  const urls = [];
  if (typeof tab.url === "string" && tab.url.startsWith("http")) {
    urls.push(tab.url);
    try {
      state.activeHost = new URL(tab.url).hostname;
    } catch (_err) {
      state.activeHost = "";
    }
  }
  if (tab.id !== undefined) {
    urls.push(...(await collectUrlsFromTab(tab.id)));
  }
  state.activeUrls = normalizeUrls(urls);
}

function isSetActive(set) {
  if (!set || !set.enabled) {
    return false;
  }
  const probe = { ...set, enabled: true };
  return state.activeUrls.some((url) => ModCore.getMatchingSets([probe], url, "GET").length > 0);
}

// ---------- model helpers ----------

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getModType(type) {
  return MOD_TYPES.find((t) => t.value === type) || null;
}

function isAddHeaderType(type) {
  return type === "addRequestHeader" || type === "addResponseHeader";
}

function isModifyHeaderType(type) {
  return type === "modifyRequestHeader" || type === "modifyResponseHeader";
}

function isRequestHeaderType(type) {
  return type === "addRequestHeader" || type === "modifyRequestHeader";
}

function isBodyModType(type) {
  return type === "editRequestBody" || type === "editResponseBody";
}

function isBlockModType(type) {
  return type === "blockRequest";
}

function getSetMethods(match) {
  if (!match || typeof match !== "object") {
    return [];
  }
  if (Array.isArray(match.methods)) {
    return match.methods.map((m) => String(m || "").trim().toUpperCase()).filter(Boolean);
  }
  if (typeof match.method === "string" && match.method.trim()) {
    return [match.method.trim().toUpperCase()];
  }
  return [];
}

function getSetCondition(match) {
  const headerName = String((match && match.condition && match.condition.headerName) || "").trim();
  if (!headerName) {
    return null;
  }
  return { headerName, pattern: String(match.condition.pattern || "").trim() };
}

function normalizeMod(mod) {
  if (!mod || typeof mod !== "object") {
    return null;
  }
  const type = String(mod.type || "");
  if (!getModType(type)) {
    return null;
  }
  return {
    id: String(mod.id || uid()),
    type,
    enabled: mod.enabled !== false,
    headerName: String(mod.headerName || "").trim(),
    headerValue: String(mod.headerValue ?? ""),
    from: String(mod.from ?? ""),
    to: String(mod.to ?? ""),
    isRegex: Boolean(mod.isRegex),
    regexFlags: String(mod.regexFlags || "").trim()
  };
}

function normalizeSet(set) {
  if (!set || typeof set !== "object") {
    return null;
  }
  const name = String(set.name || "").trim();
  const urlPattern = String((set.match && set.match.urlPattern) || "").trim();
  if (!name || !urlPattern) {
    return null;
  }
  return {
    id: String(set.id || uid()),
    name,
    enabled: set.enabled !== false,
    match: {
      urlPattern,
      methods: getSetMethods(set.match),
      condition: getSetCondition(set.match)
    },
    mods: Array.isArray(set.mods) ? set.mods.map(normalizeMod).filter(Boolean) : []
  };
}

function getSetFingerprint(set) {
  const methods = getSetMethods(set.match).slice().sort().join(",");
  const name = String(set.name || "").trim().toLowerCase();
  const url = String((set.match && set.match.urlPattern) || "").trim();
  return `${name}|${url}|${methods}`;
}

function ensureUniqueCollectionIds(sets) {
  const usedSetIds = new Set();
  const normalized = [];

  for (const rawSet of sets || []) {
    const set = normalizeSet(rawSet);
    if (!set) {
      continue;
    }
    while (usedSetIds.has(set.id)) {
      set.id = uid();
    }
    usedSetIds.add(set.id);

    const usedModIds = new Set();
    set.mods = set.mods.map((mod) => {
      const next = { ...mod };
      while (usedModIds.has(next.id)) {
        next.id = uid();
      }
      usedModIds.add(next.id);
      return next;
    });

    normalized.push(set);
  }

  return normalized;
}

function extractImportedSets(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === "object" && Array.isArray(data.modSets)) {
    return data.modSets;
  }
  return [];
}

function mergeCollections(existingSets, incomingSets) {
  const next = ensureUniqueCollectionIds(existingSets);

  for (const rawIncoming of incomingSets) {
    const incoming = normalizeSet(rawIncoming);
    if (!incoming) {
      continue;
    }

    let targetIndex = next.findIndex((s) => s.id === incoming.id);
    if (targetIndex < 0) {
      const fp = getSetFingerprint(incoming);
      targetIndex = next.findIndex((s) => getSetFingerprint(s) === fp);
    }

    if (targetIndex >= 0) {
      next[targetIndex] = { ...incoming, id: next[targetIndex].id };
      continue;
    }
    next.push(incoming);
  }

  return ensureUniqueCollectionIds(next);
}

function regexError(pattern, flags) {
  try {
    new RegExp(pattern, flags);
    return "";
  } catch (err) {
    return err.message;
  }
}

// "/.../flags" in a pattern field means regex; anything else is a substring.
function patternError(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("/") || trimmed.lastIndexOf("/") <= 0) {
    return "";
  }
  const lastSlash = trimmed.lastIndexOf("/");
  return regexError(trimmed.slice(1, lastSlash), trimmed.slice(lastSlash + 1));
}

// ---------- summaries ----------

// Quote only where the bare value would be invisible or ambiguous; JSON-ish values already carry quotes.
function quote(value) {
  if (value === "") {
    return "(empty)";
  }
  return /^\s|\s$/.test(value) ? `“${value}”` : value;
}

function describeMatcher(mod) {
  if (!mod.from) {
    return "";
  }
  return mod.isRegex ? `/${mod.from}/${mod.regexFlags || "g"}` : quote(mod.from);
}

function modSummary(mod) {
  if (isBlockModType(mod.type)) {
    return "Block matching requests";
  }
  if (isAddHeaderType(mod.type)) {
    return `${mod.headerName || "?"}: ${mod.headerValue}`;
  }
  const matcher = describeMatcher(mod);
  if (isModifyHeaderType(mod.type)) {
    return matcher
      ? `${mod.headerName || "?"}: ${matcher} → ${quote(mod.to)}`
      : `${mod.headerName || "?"} = ${quote(mod.to)}`;
  }
  return `${matcher} → ${quote(mod.to)}`;
}

function setMatchesQuery(set, query) {
  if (!query) {
    return true;
  }
  const haystack = [set.name, set.match && set.match.urlPattern, ...(set.mods || []).map(modSummary)]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

// ---------- rendering ----------

function renderMethodChips(selected) {
  const chosen = new Set(selected);
  return HTTP_METHODS.map(
    (method) => html`<label class="chip"><input type="checkbox" name="methods" value="${method}" ${raw(
      chosen.has(method) ? "checked" : ""
    )} /><span>${method}</span></label>`
  );
}

function renderSetEditor(set, isNew) {
  const match = (set && set.match) || {};
  const condition = getSetCondition(match);
  const urlError = patternError(match.urlPattern);

  return html`
    <form class="editor" data-form="${isNew ? "new-set" : "set"}" novalidate>
      <div class="field">
        <label for="f-name">Name</label>
        <input id="f-name" name="name" required value="${(set && set.name) || ""}" placeholder="Auth tweaks" autocomplete="off" />
      </div>
      <div class="field">
        <label for="f-url">URL match</label>
        <input id="f-url" name="urlPattern" required class="mono" value="${match.urlPattern || ""}" placeholder="api.example.com  or  /^https:\\/\\/api\\./i" autocomplete="off" spellcheck="false" />
        <div class="hint" data-error-for="urlPattern">${urlError ? html`<span class="error">${urlError}</span>` : "Substring of the URL, or /regex/flags."}</div>
      </div>
      <div class="field">
        <span class="field-label">Methods <span class="muted">— none means all</span></span>
        <div class="chips">${renderMethodChips(getSetMethods(match))}</div>
      </div>
      ${condition
        ? html`<div class="hint">Also requires header <span class="mono">${condition.headerName} ~ ${condition.pattern || "*"}</span>. Change or remove it with Edit as JSON.</div>`
        : ""}
      <div class="editor-footer">
        ${isNew ? "" : html`<button type="button" class="btn link" data-action="edit-json">Edit as JSON</button>`}
        <span class="spacer"></span>
        <button type="button" class="btn" data-action="cancel">Cancel</button>
        <button type="submit" class="btn primary">${isNew ? "Create set" : "Save"}</button>
      </div>
    </form>
  `;
}

function renderJsonEditor(set) {
  const { id: _id, ...editable } = set;
  return html`
    <form class="editor" data-form="json" novalidate>
      <textarea name="json" class="mono json" rows="14" spellcheck="false">${JSON.stringify(editable, null, 2)}</textarea>
      ${state.editorError ? html`<div class="hint"><span class="error">${state.editorError}</span></div>` : ""}
      <div class="editor-footer">
        <span class="hint">⌘/Ctrl+Enter to save</span>
        <span class="spacer"></span>
        <button type="button" class="btn" data-action="cancel">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>
  `;
}

function renderModTypeSelect(selectedType) {
  const groups = ["Request", "Response"];
  return html`<select name="type" aria-label="Mod type">${groups.map(
    (group) =>
      html`<optgroup label="${group}">${MOD_TYPES.filter((t) => t.group === group).map(
        (t) => html`<option value="${t.value}" ${raw(t.value === selectedType ? "selected" : "")}>${group} · ${t.label}</option>`
      )}</optgroup>`
  )}</select>`;
}

function renderModEditor(mod, isNew) {
  return html`
    <form class="editor mod-editor" data-form="${isNew ? "new-mod" : "mod"}" novalidate>
      <div class="field">${renderModTypeSelect(mod.type)}</div>
      <div class="field" data-show="header">
        <label for="f-header">Header</label>
        <input id="f-header" name="headerName" value="${mod.headerName}" placeholder="X-Debug" autocomplete="off" spellcheck="false" />
      </div>
      <div class="field" data-show="add-header">
        <label for="f-value">Value</label>
        <input id="f-value" name="headerValue" value="${mod.headerValue}" placeholder="enabled" autocomplete="off" spellcheck="false" />
      </div>
      <div class="field" data-show="replace">
        <label for="f-from" data-label-for="from">Find</label>
        <input id="f-from" name="from" class="mono" value="${mod.from}" autocomplete="off" spellcheck="false" />
        <div class="hint" data-error-for="from"></div>
      </div>
      <div class="field" data-show="replace">
        <label for="f-to" data-label-for="to">Replace with</label>
        <input id="f-to" name="to" class="mono" value="${mod.to}" autocomplete="off" spellcheck="false" />
      </div>
      <div class="field row regex-row" data-show="replace">
        <label class="check"><input type="checkbox" name="isRegex" ${raw(mod.isRegex ? "checked" : "")} /> Regex</label>
        <input name="regexFlags" class="mono flags" value="${mod.regexFlags}" placeholder="g" aria-label="Regex flags" autocomplete="off" spellcheck="false" />
      </div>
      <div class="notes" data-notes></div>
      ${state.editorError ? html`<div class="hint"><span class="error">${state.editorError}</span></div>` : ""}
      <div class="editor-footer">
        <span class="spacer"></span>
        <button type="button" class="btn" data-action="cancel">Cancel</button>
        <button type="submit" class="btn primary">${isNew ? "Add mod" : "Save"}</button>
      </div>
    </form>
  `;
}

function renderMod(set, mod) {
  const editor = state.editor;
  if (editor && editor.kind === "mod" && editor.setId === set.id && editor.modId === mod.id) {
    return html`<li class="mod editing" data-mod-id="${mod.id}">${renderModEditor(mod, false)}</li>`;
  }

  const type = getModType(mod.type);
  const summary = modSummary(mod);
  return html`
    <li class="mod ${mod.enabled === false ? "is-off" : ""} ${isBlockModType(mod.type) ? "is-block" : ""}" data-mod-id="${mod.id}" data-drop="mod">
      <span class="handle" draggable="true" data-drag="mod" title="Drag to reorder">${icon("drag")}</span>
      <input type="checkbox" class="mini-switch" data-action="toggle-mod" ${raw(mod.enabled === false ? "" : "checked")} title="${mod.enabled === false ? "Enable mod" : "Disable mod"}" aria-label="Enable mod" />
      <button type="button" class="mod-main" data-action="edit-mod" title="${summary}">
        <span class="tag tag-${type ? type.group.toLowerCase() : "request"}">${type ? type.short : mod.type}</span>
        <span class="mod-summary mono">${summary}</span>
      </button>
      <span class="row-actions">
        <button type="button" class="icon-btn sm" data-action="duplicate-mod" title="Duplicate" aria-label="Duplicate mod">${icon("copy")}</button>
        <button type="button" class="icon-btn sm danger" data-action="delete-mod" title="Delete" aria-label="Delete mod">${icon("trash")}</button>
      </span>
    </li>
  `;
}

function renderSetMeta(set) {
  const methods = getSetMethods(set.match);
  const condition = getSetCondition(set.match);
  return html`
    <span class="mono">${set.match.urlPattern}</span>
    ${methods.map((m) => html`<span class="badge">${m}</span>`)}
    ${condition ? html`<span class="muted">if ${condition.headerName} ~ ${condition.pattern || "*"}</span>` : ""}
  `;
}

function renderSet(set) {
  const editor = state.editor;
  const editingThis = editor && editor.setId === set.id;
  const collapsed = state.collapsed.has(set.id) && !editingThis;
  const active = isSetActive(set);
  const modCount = set.mods.length;
  const offCount = set.mods.filter((m) => m.enabled === false).length;

  let head;
  if (editingThis && editor.kind === "set") {
    head = renderSetEditor(set, false);
  } else if (editingThis && editor.kind === "json") {
    head = renderJsonEditor(set);
  } else {
    head = html`
      <div class="set-head">
        <span class="handle" draggable="true" data-drag="set" title="Drag to reorder">${icon("drag")}</span>
        <input type="checkbox" class="switch" data-action="toggle-set" ${raw(set.enabled ? "checked" : "")} title="${set.enabled ? "Disable set" : "Enable set"}" aria-label="Enable set" />
        <button type="button" class="set-title" data-action="fold" aria-expanded="${collapsed ? "false" : "true"}">
          <span class="set-name">
            <span class="dot ${active ? "on" : ""}" title="${active ? "Matches this page or its assets" : "No match on this page"}"></span>
            ${set.name}
            <span class="count">${modCount === 0 ? "no mods" : `${modCount} mod${modCount === 1 ? "" : "s"}${offCount ? `, ${offCount} off` : ""}`}</span>
          </span>
          <span class="set-meta">${renderSetMeta(set)}</span>
        </button>
        <span class="row-actions">
          <button type="button" class="icon-btn sm" data-action="edit-set" title="Edit set" aria-label="Edit set">${icon("edit")}</button>
          <button type="button" class="icon-btn sm" data-action="duplicate-set" title="Duplicate set" aria-label="Duplicate set">${icon("copy")}</button>
          <button type="button" class="icon-btn sm danger" data-action="delete-set" title="Delete set" aria-label="Delete set">${icon("trash")}</button>
        </span>
        <button type="button" class="icon-btn sm fold ${collapsed ? "is-collapsed" : ""}" data-action="fold" aria-label="${collapsed ? "Expand" : "Collapse"}">${icon("chevron")}</button>
      </div>
    `;
  }

  const addingMod = editor && editor.kind === "new-mod" && editor.setId === set.id;
  const body = collapsed
    ? ""
    : html`
        <ul class="mods">${set.mods.map((mod) => renderMod(set, mod))}</ul>
        ${addingMod
          ? html`<div class="mod editing">${renderModEditor(blankMod(), true)}</div>`
          : html`<button type="button" class="add-mod" data-action="add-mod">${icon("plus")} Add mod</button>`}
      `;

  return html`
    <section class="set ${set.enabled ? "" : "is-off"}" data-set-id="${set.id}" data-drop="set">
      ${head}
      ${body}
    </section>
  `;
}

function blankMod() {
  return { type: "addRequestHeader", headerName: "", headerValue: "", from: "", to: "", isRegex: false, regexFlags: "" };
}

function blankSet() {
  const host = state.activeHost;
  return { name: host || "", match: { urlPattern: host || "", methods: [], condition: null } };
}

function renderEmpty() {
  return html`
    <div class="empty">
      <p><strong>No mod sets yet.</strong></p>
      <p class="muted">A set targets URLs and holds an ordered list of mods: add or rewrite headers, edit bodies, block requests.</p>
      <button type="button" class="btn primary" data-action="new-set">Create one${state.activeHost ? ` for ${state.activeHost}` : ""}</button>
    </div>
  `;
}

function renderSummary() {
  const activeCount = state.sets.filter(isSetActive).length;
  const enabledCount = state.sets.filter((s) => s.enabled).length;
  if (state.sets.length === 0) {
    pageSummary.textContent = state.activeHost || "";
    return;
  }
  const parts = [`${enabledCount}/${state.sets.length} enabled`];
  if (state.activeHost) {
    parts.push(`${activeCount} on ${state.activeHost}`);
  }
  pageSummary.textContent = parts.join(" · ");
}

function render() {
  renderSummary();
  searchWrap.hidden = state.sets.length < SEARCH_THRESHOLD && !state.query;

  const parts = [];
  if (state.editor && state.editor.kind === "new-set") {
    parts.push(html`<section class="set is-new">${renderSetEditor(blankSet(), true)}</section>`);
  }

  if (state.sets.length === 0 && !parts.length) {
    parts.push(renderEmpty());
  } else {
    const visible = state.sets.filter((s) => setMatchesQuery(s, state.query));
    parts.push(...visible.map(renderSet));
    if (state.query && visible.length === 0) {
      parts.push(html`<div class="empty muted">No sets match “${state.query}”.</div>`);
    }
  }

  const draft = captureDraft();
  setsContainer.innerHTML = toMarkup(parts);

  const form = setsContainer.querySelector("form.editor");
  const key = editorKey(state.editor);
  if (form) {
    if (draft && draft.key === key) {
      restoreDraft(form, draft);
    }
    syncModForm(form);
    syncSetForm(form);
    if (key !== lastEditorKey) {
      const fields = Array.from(form.querySelectorAll("input:not([type=checkbox]), textarea, select"));
      const focusTarget = fields.find((el) => el.tagName !== "SELECT" && el.offsetParent !== null) || fields[0];
      if (focusTarget) {
        focusTarget.focus();
      }
      form.scrollIntoView({ block: "nearest" });
    }
  }
  lastEditorKey = key;
}

// Re-renders (toggles elsewhere, failed JSON saves) must not discard what the user typed.
let lastEditorKey = "";

function editorKey(editor) {
  return editor ? [editor.kind, editor.setId || "", editor.modId || ""].join(":") : "";
}

function captureDraft() {
  const form = setsContainer.querySelector("form.editor");
  if (!form) {
    return null;
  }
  const fields = Array.from(form.elements)
    .filter((el) => el.name)
    .map((el) => (el.type === "checkbox" ? el.checked : el.value));
  return { key: lastEditorKey, fields };
}

function restoreDraft(form, draft) {
  const elements = Array.from(form.elements).filter((el) => el.name);
  elements.forEach((el, i) => {
    if (i >= draft.fields.length) {
      return;
    }
    if (el.type === "checkbox") {
      el.checked = draft.fields[i];
    } else {
      el.value = draft.fields[i];
    }
  });
}

// ---------- live form behavior ----------

function setNote(container, kind, text) {
  container.insertAdjacentHTML("beforeend", toMarkup(html`<div class="note note-${kind}">${text}</div>`));
}

function syncModForm(form) {
  if (form.dataset.form !== "mod" && form.dataset.form !== "new-mod") {
    return;
  }

  const type = form.elements.type.value;
  const isAdd = isAddHeaderType(type);
  const isModify = isModifyHeaderType(type);
  const isBody = isBodyModType(type);
  const show = {
    header: isAdd || isModify,
    "add-header": isAdd,
    replace: isModify || isBody
  };
  for (const el of form.querySelectorAll("[data-show]")) {
    el.hidden = !show[el.dataset.show];
  }

  const isRegex = form.elements.isRegex.checked;
  form.elements.regexFlags.hidden = !isRegex;
  form.querySelector("[data-label-for='from']").textContent = isModify ? "Find in value (optional)" : "Find";
  form.querySelector("[data-label-for='to']").textContent = isModify ? "New value" : "Replace with";
  form.elements.from.placeholder = isModify ? "empty = replace whole value" : isRegex ? "(\\w+)@example\\.com" : "text to find";
  form.elements.to.placeholder = isRegex && isBody ? "$1 or $<name>" : isModify ? "new header value" : "replacement";

  const fromError = isRegex && form.elements.from.value ? regexError(form.elements.from.value, form.elements.regexFlags.value || "g") : "";
  form.querySelector("[data-error-for='from']").innerHTML = fromError ? toMarkup(html`<span class="error">${fromError}</span>`) : "";

  const notes = form.querySelector("[data-notes]");
  notes.innerHTML = "";
  if (isBlockModType(type)) {
    setNote(notes, "danger", "Blocks every request that matches this set's URL and methods.");
  }
  if (isModify && (isRegex || /\$\d+|\$<[^>]+>/.test(form.elements.to.value))) {
    setNote(notes, "warn", "Network-level header rules can't use captures: “New value” is set literally. Captures apply to page fetch() only.");
  }
  if (isRequestHeaderType(type) && form.elements.headerName.value.trim().toLowerCase() === "cookie") {
    setNote(notes, "warn", "Chrome doesn't reliably let extensions rewrite the Cookie request header.");
  }
  if (isBody) {
    setNote(notes, "info", "Applies to page fetch() with textual content types.");
  }
}

function syncSetForm(form) {
  if (form.dataset.form !== "set" && form.dataset.form !== "new-set") {
    return;
  }
  const error = patternError(form.elements.urlPattern.value);
  const hint = form.querySelector("[data-error-for='urlPattern']");
  hint.innerHTML = error
    ? toMarkup(html`<span class="error">${error}</span>`)
    : "Substring of the URL, or /regex/flags.";
}

// ---------- form reading & validation ----------

function readSetForm(form) {
  const values = new FormData(form);
  return {
    name: String(values.get("name") || "").trim(),
    match: {
      urlPattern: String(values.get("urlPattern") || "").trim(),
      methods: values.getAll("methods").map(String),
      condition: null
    }
  };
}

function validateSet(data) {
  if (!data.name) {
    return { field: "name", message: "Give the set a name." };
  }
  if (!data.match.urlPattern) {
    return { field: "urlPattern", message: "URL match is required." };
  }
  const error = patternError(data.match.urlPattern);
  if (error) {
    return { field: "urlPattern", message: error };
  }
  return null;
}

function readModForm(form) {
  const values = new FormData(form);
  const type = String(values.get("type") || "");
  const mod = {
    type,
    headerName: String(values.get("headerName") || "").trim(),
    headerValue: String(values.get("headerValue") || ""),
    from: String(values.get("from") || ""),
    to: String(values.get("to") || ""),
    isRegex: values.get("isRegex") === "on",
    regexFlags: String(values.get("regexFlags") || "").trim()
  };

  // Keep only the fields the type uses so stale values never leak into rules.
  if (!isAddHeaderType(type) && !isModifyHeaderType(type)) {
    mod.headerName = "";
  }
  if (isModifyHeaderType(type)) {
    // With no "find", core applies headerValue; background applies "to". Keep them aligned.
    mod.headerValue = mod.to;
  } else if (!isAddHeaderType(type)) {
    mod.headerValue = "";
  }
  if (isAddHeaderType(type) || isBlockModType(type)) {
    mod.from = "";
    mod.to = "";
    mod.isRegex = false;
  }
  if (!mod.isRegex) {
    mod.regexFlags = "";
  }
  return mod;
}

function validateMod(mod) {
  if ((isAddHeaderType(mod.type) || isModifyHeaderType(mod.type)) && !mod.headerName) {
    return { field: "headerName", message: "Header name is required." };
  }
  if (isAddHeaderType(mod.type) && !mod.headerValue) {
    return { field: "headerValue", message: "Header value is required." };
  }
  if (isBodyModType(mod.type) && !mod.from) {
    return { field: "from", message: "Enter the text to find." };
  }
  if (mod.isRegex && mod.from) {
    const error = regexError(mod.from, mod.regexFlags || "g");
    if (error) {
      return { field: "from", message: error };
    }
  }
  return null;
}

function showFormError(form, error) {
  state.editorError = "";
  let hint = form.querySelector(`[data-error-for='${error.field}']`);
  const input = form.elements[error.field];
  if (!hint && input) {
    hint = document.createElement("div");
    hint.className = "hint";
    hint.dataset.errorFor = error.field;
    input.insertAdjacentElement("afterend", hint);
  }
  if (hint) {
    hint.innerHTML = toMarkup(html`<span class="error">${error.message}</span>`);
  }
  if (input && input.focus) {
    input.focus();
  }
}

// ---------- actions ----------

function findSet(setId) {
  return state.sets.find((s) => s.id === setId) || null;
}

function openEditor(editor) {
  state.editor = editor;
  state.editorError = "";
  if (editor && editor.setId) {
    state.collapsed.delete(editor.setId);
    saveCollapsed();
  }
  render();
}

function closeEditor() {
  state.editor = null;
  state.editorError = "";
  render();
}

function cloneWithNewIds(set) {
  const copy = structuredClone(set);
  copy.id = uid();
  copy.mods = (copy.mods || []).map((m) => ({ ...m, id: uid() }));
  return copy;
}

async function handleSetAction(action, setId, modId, target) {
  const set = findSet(setId);
  if (!set) {
    return;
  }

  switch (action) {
    case "fold":
      if (state.collapsed.has(setId)) {
        state.collapsed.delete(setId);
      } else {
        state.collapsed.add(setId);
      }
      saveCollapsed();
      render();
      return;
    case "toggle-set":
      await commit(() => {
        set.enabled = target.checked;
      });
      return;
    case "edit-set":
      openEditor({ kind: "set", setId });
      return;
    case "edit-json":
      openEditor({ kind: "json", setId });
      return;
    case "duplicate-set":
      await commit((sets) => {
        const copy = cloneWithNewIds(set);
        copy.name = `${set.name} copy`;
        sets.splice(sets.indexOf(set) + 1, 0, copy);
      });
      return;
    case "delete-set":
      if (state.editor && state.editor.setId === setId) {
        state.editor = null;
      }
      await commit((sets) => {
        sets.splice(sets.indexOf(set), 1);
      }, `Deleted “${set.name}”`);
      return;
    case "add-mod":
      openEditor({ kind: "new-mod", setId });
      return;
    case "edit-mod":
      openEditor({ kind: "mod", setId, modId });
      return;
    case "toggle-mod":
      await commit(() => {
        const mod = set.mods.find((m) => m.id === modId);
        if (mod) {
          mod.enabled = target.checked;
        }
      });
      return;
    case "duplicate-mod":
      await commit(() => {
        const idx = set.mods.findIndex((m) => m.id === modId);
        if (idx >= 0) {
          set.mods.splice(idx + 1, 0, { ...set.mods[idx], id: uid() });
        }
      });
      return;
    case "delete-mod":
      if (state.editor && state.editor.modId === modId) {
        state.editor = null;
      }
      await commit(() => {
        set.mods = set.mods.filter((m) => m.id !== modId);
      }, "Deleted mod");
      return;
    default:
      return;
  }
}

async function handleSubmit(form) {
  const kind = form.dataset.form;
  const editor = state.editor;

  if (kind === "new-set" || kind === "set") {
    const data = readSetForm(form);
    const error = validateSet(data);
    if (error) {
      showFormError(form, error);
      return;
    }

    if (kind === "new-set") {
      const set = { id: uid(), enabled: true, ...data, mods: [] };
      state.editor = { kind: "new-mod", setId: set.id };
      await commit((sets) => {
        sets.unshift(set);
      });
      return;
    }

    state.editor = null;
    await commit(() => {
      const set = findSet(editor.setId);
      set.name = data.name;
      // Header conditions are no longer editable in the form; keep any an imported set carries.
      set.match = { ...data.match, condition: set.match.condition || null };
    });
    return;
  }

  if (kind === "json") {
    let parsed;
    try {
      parsed = JSON.parse(form.elements.json.value);
    } catch (err) {
      state.editorError = `Invalid JSON: ${err.message}`;
      render();
      return;
    }
    const normalized = normalizeSet({ ...parsed, id: editor.setId });
    if (!normalized) {
      state.editorError = "A set needs a “name” and “match.urlPattern”.";
      render();
      return;
    }
    const error = validateSet(normalized) || normalized.mods.map(validateMod).find(Boolean);
    if (error) {
      state.editorError = error.message;
      render();
      return;
    }
    state.editor = null;
    state.editorError = "";
    await commit((sets) => {
      sets[sets.findIndex((s) => s.id === editor.setId)] = normalized;
    });
    return;
  }

  if (kind === "new-mod" || kind === "mod") {
    const mod = readModForm(form);
    const error = validateMod(mod);
    if (error) {
      showFormError(form, error);
      return;
    }

    state.editor = null;
    await commit(() => {
      const set = findSet(editor.setId);
      if (kind === "new-mod") {
        set.mods.push({ id: uid(), enabled: true, ...mod });
      } else {
        const idx = set.mods.findIndex((m) => m.id === editor.modId);
        set.mods[idx] = { ...set.mods[idx], ...mod };
      }
    });
  }
}

// ---------- toast & undo ----------

function showToast(message, withUndo) {
  clearTimeout(toastTimer);
  toast.innerHTML = toMarkup(html`
    <span>${message}</span>
    ${withUndo ? html`<button type="button" class="btn link" data-action="undo">Undo</button>` : ""}
  `);
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
    undoSnapshot = null;
  }, withUndo ? 6000 : 3000);
}

toast.addEventListener("click", async (event) => {
  if (!event.target.closest("[data-action='undo']") || !undoSnapshot) {
    return;
  }
  state.sets = undoSnapshot;
  undoSnapshot = null;
  await saveSets(state.sets);
  showToast("Restored", false);
  render();
});

// ---------- import / export ----------

function downloadJsonFile(fileName, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

exportBtn.addEventListener("click", () => {
  const payload = {
    format: "http-mod-sets",
    version: 1,
    exportedAt: new Date().toISOString(),
    modSets: ensureUniqueCollectionIds(state.sets)
  };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadJsonFile(`http-mod-sets-${stamp}.json`, payload);
  showToast(`Exported ${payload.modSets.length} set${payload.modSets.length === 1 ? "" : "s"}`, false);
});

importBtn.addEventListener("click", () => {
  importFileInput.value = "";
  importFileInput.click();
});

importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files && importFileInput.files[0];
  if (!file) {
    return;
  }
  try {
    const incoming = extractImportedSets(JSON.parse(await file.text()))
      .map(normalizeSet)
      .filter(Boolean);
    if (incoming.length === 0) {
      showToast("No mod sets found in that file", false);
      return;
    }
    state.pendingImport = { fileName: file.name, sets: incoming };
    renderImportBanner();
  } catch (err) {
    showToast(`Import failed: ${err.message}`, false);
  }
});

function renderImportBanner() {
  const pending = state.pendingImport;
  importBanner.hidden = !pending;
  if (!pending) {
    importBanner.innerHTML = "";
    return;
  }
  const n = pending.sets.length;
  importBanner.innerHTML = toMarkup(html`
    <div><strong>${n} set${n === 1 ? "" : "s"}</strong> in ${pending.fileName}</div>
    <div class="banner-actions">
      <button type="button" class="btn" data-import="cancel">Cancel</button>
      ${state.sets.length ? html`<button type="button" class="btn" data-import="override" title="Remove current sets and use the file's">Replace all</button>` : ""}
      <button type="button" class="btn primary" data-import="merge" title="Add new sets, update sets with the same id or name + URL">${state.sets.length ? "Merge" : "Import"}</button>
    </div>
  `);
}

importBanner.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-import]");
  const pending = state.pendingImport;
  if (!button || !pending) {
    return;
  }
  const mode = button.dataset.import;
  state.pendingImport = null;
  renderImportBanner();
  if (mode === "cancel") {
    return;
  }
  state.editor = null;
  await commit((sets) => {
    const next = mode === "override" ? ensureUniqueCollectionIds(pending.sets) : mergeCollections(sets, pending.sets);
    sets.splice(0, sets.length, ...next);
  }, mode === "override" ? `Replaced with ${pending.sets.length} imported set(s)` : `Merged ${pending.sets.length} set(s)`);
});

// ---------- event wiring ----------

newSetBtn.addEventListener("click", () => openEditor({ kind: "new-set" }));

searchInput.addEventListener("input", () => {
  state.query = searchInput.value.trim().toLowerCase();
  render();
  searchInput.focus();
});

setsContainer.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.tagName === "INPUT") {
    return;
  }
  const action = target.dataset.action;

  if (action === "new-set") {
    openEditor({ kind: "new-set" });
    return;
  }
  if (action === "cancel") {
    closeEditor();
    return;
  }

  const setEl = target.closest("[data-set-id]");
  const modEl = target.closest("[data-mod-id]");
  if (!setEl) {
    return;
  }
  await handleSetAction(action, setEl.dataset.setId, modEl ? modEl.dataset.modId : null, target);
});

// Checkbox toggles fire "change", not "click", for reliable checked state.
setsContainer.addEventListener("change", async (event) => {
  const target = event.target;
  const form = target.closest("form.editor");
  if (form) {
    syncModForm(form);
    return;
  }
  if (!(target instanceof HTMLInputElement) || !target.dataset.action) {
    return;
  }
  const setEl = target.closest("[data-set-id]");
  const modEl = target.closest("[data-mod-id]");
  if (setEl) {
    await handleSetAction(target.dataset.action, setEl.dataset.setId, modEl ? modEl.dataset.modId : null, target);
  }
});

setsContainer.addEventListener("input", (event) => {
  const form = event.target.closest("form.editor");
  if (form) {
    syncModForm(form);
    syncSetForm(form);
  }
});

setsContainer.addEventListener("submit", (event) => {
  event.preventDefault();
  handleSubmit(event.target);
});

document.addEventListener("keydown", (event) => {
  const inEditor = event.target.closest && event.target.closest("form.editor");

  if (event.key === "Escape") {
    if (state.pendingImport) {
      state.pendingImport = null;
      renderImportBanner();
      event.preventDefault();
      return;
    }
    if (state.editor) {
      closeEditor();
      event.preventDefault();
    }
    return;
  }

  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && inEditor) {
    event.preventDefault();
    inEditor.requestSubmit();
    return;
  }

  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === "n") {
      event.preventDefault();
      openEditor({ kind: "new-set" });
    } else if (event.key === "/" && !searchWrap.hidden) {
      event.preventDefault();
      searchInput.focus();
    }
  }
});

// ---------- drag to reorder (sets and mods) ----------

let drag = null;

function clearDropMarkers() {
  for (const el of setsContainer.querySelectorAll(".drop-before, .drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
}

function dropTargetFor(event) {
  if (!drag) {
    return null;
  }
  const el = event.target.closest(`[data-drop='${drag.kind}']`);
  if (!el || el === drag.el) {
    return null;
  }
  // Mods only reorder within their own set.
  if (drag.kind === "mod" && el.closest("[data-set-id]") !== drag.el.closest("[data-set-id]")) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  return { el, before: event.clientY - rect.top < rect.height / 2 };
}

setsContainer.addEventListener("dragstart", (event) => {
  const handle = event.target.closest && event.target.closest("[data-drag]");
  if (!handle) {
    return;
  }
  const kind = handle.dataset.drag;
  const el = handle.closest(`[data-drop='${kind}']`);
  drag = { kind, el };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", "");
  event.dataTransfer.setDragImage(el, 16, 16);
  el.classList.add("dragging");
});

setsContainer.addEventListener("dragover", (event) => {
  const target = dropTargetFor(event);
  if (!target) {
    return;
  }
  event.preventDefault();
  clearDropMarkers();
  target.el.classList.add(target.before ? "drop-before" : "drop-after");
});

setsContainer.addEventListener("dragend", () => {
  if (drag) {
    drag.el.classList.remove("dragging");
  }
  clearDropMarkers();
  drag = null;
});

function moveItem(list, fromId, toId, before) {
  const fromIdx = list.findIndex((x) => x.id === fromId);
  if (fromIdx < 0) {
    return;
  }
  const [moved] = list.splice(fromIdx, 1);
  const toIdx = list.findIndex((x) => x.id === toId);
  list.splice(toIdx < 0 ? fromIdx : before ? toIdx : toIdx + 1, 0, moved);
}

setsContainer.addEventListener("drop", async (event) => {
  const target = dropTargetFor(event);
  if (!target) {
    return;
  }
  event.preventDefault();
  const current = drag;
  clearDropMarkers();

  if (current.kind === "set") {
    await commit((sets) => moveItem(sets, current.el.dataset.setId, target.el.dataset.setId, target.before));
  } else {
    const set = findSet(current.el.closest("[data-set-id]").dataset.setId);
    await commit(() => moveItem(set.mods, current.el.dataset.modId, target.el.dataset.modId, target.before));
  }
});

// ---------- boot ----------

importBtn.innerHTML = toMarkup(icon("upload"));
exportBtn.innerHTML = toMarkup(icon("download"));

api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) {
    return;
  }
  const next = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
  // Our own writes already updated state; only re-render for writes from elsewhere, and never under an open editor.
  if (JSON.stringify(next) !== JSON.stringify(state.sets) && !state.editor) {
    state.sets = ensureUniqueCollectionIds(next);
    render();
  }
});

(async function boot() {
  state.sets = ensureUniqueCollectionIds(await loadSets());
  render();
  await loadActivePage();
  render();
})();
