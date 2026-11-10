"use strict";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Single source of truth for selectable models (used by both selects).
const MODELS = [
  { id: "gemini-3.5-flash-lite", label: "Flash-Lite 3.5 (економна)" },
  { id: "gemini-3.8-flash", label: "Flash 3.8 (середня)" },
  { id: "gemini-4-argon", label: "Argon 4 (флагман)" },
];
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

// Thinking budget (tokens) per model. Makes the agent PLAN before each tool
// call instead of reflex-probing the DOM. 0 = thinking off (Flash-Lite: keep
// it off so the one model that survives the free tier stays fast and cheap).
const THINKING_BUDGET = {
  "gemini-3.5-flash-lite": 0,
  "gemini-3.8-flash": 2048,
  "gemini-4-argon": 4096,
};

// Selectable models. Starts as the curated hardcoded list; replaced by the live
// ListModels result once a valid key is saved (falls back to this on failure).
let models = MODELS.slice();

// ---- DOM ----
const els = {
  chatLog: document.getElementById("chat-log"),
  input: document.getElementById("user-input"),
  sendBtn: document.getElementById("send-btn"),
  attachBtn: document.getElementById("attach-btn"),
  fileInput: document.getElementById("file-input"),
  attachments: document.getElementById("attachments"),
  contextBtn: document.getElementById("context-btn"),
  eyesBtn: document.getElementById("eyes-btn"),
  themeBtn: document.getElementById("theme-btn"),
  confirmBtn: document.getElementById("confirm-btn"),
  recordBtn: document.getElementById("record-btn"),
  macroSelect: document.getElementById("macro-select"),
  macroPlay: document.getElementById("macro-play"),
  sessionSelect: document.getElementById("session-select"),
  newSessionBtn: document.getElementById("new-session-btn"),
  contextBadge: document.getElementById("context-badge"),
  clearBtn: document.getElementById("clear-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsView: document.getElementById("settings-view"),
  chatView: document.getElementById("chat-view"),
  apiKeyInput: document.getElementById("api-key-input"),
  modelSelect: document.getElementById("model-select"),
  modelQuick: document.getElementById("model-quick"),
  saveSettingsBtn: document.getElementById("save-settings-btn"),
  settingsStatus: document.getElementById("settings-status"),
  mascot: document.getElementById("mascot"),
  renameSessionBtn: document.getElementById("rename-session-btn"),
  deleteSessionBtn: document.getElementById("delete-session-btn"),
};

// ---- State ----
let settings = { apiKey: "", model: DEFAULT_MODEL };
let history = []; // [{ role: 'user'|'model', parts: [...] }] — the API conversation
let transcript = []; // display items for re-render: {role:'user',text,imgCount}|{role:'gemini',text,tokens}
let sessions = {}; // id -> { id, title, updatedAt, history, transcript }
let sessionId = null; // active session id
let windowId = null; // the browser window this side panel lives in (sessions are per-window)
let pendingImages = []; // [{ mimeType, data(base64), url }]
let pageContext = null; // { url, title, text } or null
let busy = false;

// Assistant tab group: scopes the assistant to one browser window and shows
// request status in the group title. title-only (Chrome tab groups have no
// icon field), so status is signalled with an emoji prefix.
const GROUP_NAME = "MAD";
const GROUP_STATES = {
  idle: "😺 " + GROUP_NAME,
  busy: "⏳ " + GROUP_NAME,
  done: "✅ " + GROUP_NAME,
  error: "⚠️ " + GROUP_NAME,
};
// Cat mascot face + animation class per state (reflected in the panel header).
const MASCOT_STATES = {
  idle: { face: "🐱", cls: "" },
  busy: { face: "🙀", cls: "thinking" },
  done: { face: "😺", cls: "happy" },
  error: { face: "😿", cls: "sad" },
};
let assistant = { groupId: null, windowId: null, tabId: null };

// Auto-read the bound tab's page on every send so the model "sees" the page
// without a manual toggle. Can be turned off with the 📄 button.
let autoContext = true;

// "Eyes": attach the debugger to the bound tab for console + network, and send
// a screenshot with each request. Off by default (debugger shows a banner).
let eyesOn = false;

// In-flight request controller, so the Stop button can abort it.
let currentController = null;
let stopRequested = false;

// Ask the user to approve each state-changing tool call (click/type/navigate/
// run_js) before it runs. Off by default (would make agentic browsing noisy);
// toggled with the ✋ button, persisted. Read-only tools never ask.
let confirmActions = false;
let pendingConfirm = null; // { resolve } while a confirm card is open

// Macro recording: capture executed tool calls so a sequence can be replayed
// without the model. Toggled with 🎬. Saved macros live in storage.local.
let recording = false;
let recordedCalls = []; // [{ name, args }] during a recording
let macros = {}; // name -> [{ name, args }]

// Abort only if the stream stalls (no bytes) for this long — not a total-time
// cap, so slow-but-progressing answers are never cut off.
const REQUEST_IDLE_MS = 60000;

// Lightweight logger: timestamped lines in the devtools console of the panel
// (right-click panel → Inspect) so a slow/stuck request is diagnosable.
function log(...args) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[assistant ${t}]`, ...args);
}

// ---- Init ----
init();

async function init() {
  populateModelSelects();

  windowId = await currentWindowId();
  await pruneWindowSessions();

  const stored = await chrome.storage.local.get([
    "apiKey", "model", "theme", "confirmActions", "macros",
    "sessions", "activeSessionId", "windowSessions",
  ]);
  settings.apiKey = stored.apiKey || "";
  settings.model = modelExists(stored.model) ? stored.model : DEFAULT_MODEL;
  els.apiKeyInput.value = settings.apiKey;
  els.modelSelect.value = settings.model;
  els.modelQuick.value = settings.model;

  confirmActions = !!stored.confirmActions;
  els.confirmBtn.classList.toggle("active", confirmActions);
  macros = stored.macros || {};
  populateMacros();

  // Restore chat sessions. Sessions are per-window: resume the chat this window
  // owned before (panel reopened in the same window), otherwise start a fresh
  // one. A brand-new browser window has no mapping, so it gets its own chat
  // instead of inheriting whatever was last active in another window.
  sessions = stored.sessions || {};
  const mine = windowId != null ? stored.windowSessions?.[windowId] : null;
  if (mine && sessions[mine]) {
    loadSessionInto(mine);
    await setActiveSession();
  } else {
    await newSession(false); // false = nothing to persist from yet
  }
  populateSessions();

  initTheme(stored.theme);
  if (!settings.apiKey) showSettings(true);

  wireEvents();
  updateSendButton();
  await resolveBoundTab();
  ensureAssistantGroup();
  updateContextBadge();
  enableEyes(); // debug (console/network/screenshot) on by default
}

// Attach the debugger eyes to the bound tab (best-effort). Users forget to
// toggle it, and the agent relies on it, so it's on by default.
async function enableEyes() {
  if (assistant.tabId == null || eyesOn) return;
  try {
    await Eyes.attach(assistant.tabId);
    eyesOn = true;
    log("eyes auto-on → tab", assistant.tabId);
  } catch (err) {
    log("auto eyes failed:", err?.message || err);
  }
  els.eyesBtn.classList.toggle("active", eyesOn);
}

// The tab the panel was opened on (set by background.js). Falls back to the
// active tab of the focused window.
async function resolveBoundTab() {
  try {
    const { boundTabId, boundWindowId } = await chrome.storage.session.get([
      "boundTabId",
      "boundWindowId",
    ]);
    if (boundTabId != null) {
      assistant.tabId = boundTabId;
      assistant.windowId = boundWindowId ?? null;
    } else {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      assistant.tabId = tab?.id ?? null;
      assistant.windowId = tab?.windowId ?? null;
    }
    log("bound tab", assistant.tabId, "window", assistant.windowId);
  } catch (err) {
    log("resolveBoundTab failed:", err?.message || err);
  }
  Tools.bind(() => assistant.tabId);
}

// ---- Assistant tab group ----
// Group the current tab into a "MAD" group so the assistant is bound
// to this window. Reuses an existing group if the active tab already has one.
async function ensureAssistantGroup() {
  if (!chrome.tabGroups || !chrome.tabs?.group) return; // API unavailable
  try {
    const tab = assistant.tabId != null ? await chrome.tabs.get(assistant.tabId) : null;
    if (!tab?.id) return;
    assistant.windowId = tab.windowId;

    // Valid existing group? keep it. Otherwise create one from the bound tab.
    if (await groupIsValid(assistant.groupId)) {
      // already bound
    } else if (tab.groupId != null && tab.groupId >= 0) {
      assistant.groupId = tab.groupId;
    } else {
      assistant.groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    }

    await chrome.tabGroups.update(assistant.groupId, { title: GROUP_NAME, color: "cyan" });
  } catch (err) {
    console.warn("ensureAssistantGroup:", err?.message || err);
  }
}

async function groupIsValid(groupId) {
  if (groupId == null) return false;
  try {
    await chrome.tabGroups.get(groupId);
    return true;
  } catch (_) {
    return false;
  }
}

// Update the group title to reflect request status (idle/busy/done/error).
// Reflect the current state on the header cat mascot (face + a short animation).
let mascotResetTimer = null;
function setMascot(state) {
  const m = els.mascot;
  if (!m) return;
  const spec = MASCOT_STATES[state] || MASCOT_STATES.idle;
  m.textContent = spec.face;
  m.classList.remove("thinking", "happy", "sad");
  if (spec.cls) m.classList.add(spec.cls);
  clearTimeout(mascotResetTimer);
  // Momentary reactions (done/error) relax back to the calm idle cat.
  if (state === "done" || state === "error") {
    mascotResetTimer = setTimeout(() => {
      m.classList.remove("happy", "sad");
      m.textContent = MASCOT_STATES.idle.face;
    }, 1600);
  }
}

async function setGroupState(state) {
  setMascot(state);
  const title = GROUP_STATES[state] || GROUP_NAME;
  try {
    if (!(await groupIsValid(assistant.groupId))) {
      await ensureAssistantGroup();
      if (!(await groupIsValid(assistant.groupId))) return;
    }
    await chrome.tabGroups.update(assistant.groupId, { title });
  } catch (err) {
    console.warn("setGroupState:", err?.message || err);
  }
}

function modelExists(id) {
  return models.some((m) => m.id === id);
}

function populateModelSelects() {
  for (const sel of [els.modelSelect, els.modelQuick]) {
    sel.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      sel.appendChild(opt);
    }
  }
}

// Fetch the account's models that support generateContent (doubles as an API-key
// check). Returns [{id,label}] or throws with a readable message.
async function fetchModels(key) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`
  );
  if (!resp.ok) {
    let body = null;
    try { body = await resp.json(); } catch (_) {}
    const e = new Error(errMessage(body, `HTTP ${resp.status}`));
    e.status = resp.status;
    throw e;
  }
  const data = await resp.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => ({
      id: String(m.name || "").replace(/^models\//, ""),
      label: m.displayName || String(m.name || "").replace(/^models\//, ""),
    }))
    .filter((m) => m.id);
}

// Validate the key and refresh the model list from it. Keeps the current
// selection if it still exists. Returns true on success.
async function refreshModels(key) {
  const fetched = await fetchModels(key);
  if (!fetched.length) return false;
  const prev = settings.model;
  models = fetched;
  if (!modelExists(prev)) settings.model = models[0].id;
  populateModelSelects();
  els.modelSelect.value = settings.model;
  els.modelQuick.value = settings.model;
  return true;
}

// Switch model from the chat bar without opening settings. Persists immediately.
async function onQuickModelChange() {
  if (busy) { els.modelQuick.value = settings.model; return; } // locked during request
  settings.model = els.modelQuick.value;
  els.modelSelect.value = settings.model;
  await chrome.storage.local.set({ model: settings.model });
}

function wireEvents() {
  els.sendBtn.addEventListener("click", onSendClick);
  els.input.addEventListener("input", updateSendButton);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  els.input.addEventListener("paste", onPaste);

  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => addImageFiles(e.target.files));

  els.contextBtn.addEventListener("click", toggleAutoContext);
  els.eyesBtn.addEventListener("click", toggleEyes);
  els.themeBtn.addEventListener("click", cycleTheme);
  els.confirmBtn.addEventListener("click", toggleConfirm);
  els.recordBtn.addEventListener("click", toggleRecord);
  els.macroPlay.addEventListener("click", playSelectedMacro);
  els.sessionSelect.addEventListener("change", (e) => switchSession(e.target.value));
  els.newSessionBtn.addEventListener("click", () => newSession(true));
  els.renameSessionBtn.addEventListener("click", renameSession);
  els.deleteSessionBtn.addEventListener("click", deleteSession);
  setupTooltips();
  window.addEventListener("pagehide", () => { if (eyesOn) Eyes.detach(); });
  els.clearBtn.addEventListener("click", clearChat);
  els.settingsBtn.addEventListener("click", () => showSettings(els.settingsView.classList.contains("hidden")));
  els.saveSettingsBtn.addEventListener("click", saveSettings);
  els.modelQuick.addEventListener("change", onQuickModelChange);
}

// ---- Tooltips ----
// Rich hover/focus popups: each control carries data-tip (title) and either
// data-desc (static) or data-on/data-off (how the assistant behaves in each
// state of a toggle; the current state is read live from the .active class).
function setupTooltips() {
  const tip = document.getElementById("tooltip");
  if (!tip) return;
  let current = null;

  const addLine = (cls, text) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    tip.appendChild(d);
  };

  const position = (el) => {
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - tw - 8));
    let top = r.bottom + 6;
    if (top + th > vh - 4) top = r.top - th - 6; // flip above if no room below
    if (top < 4) top = 4;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  };

  const show = (el) => {
    current = el;
    tip.innerHTML = "";
    addLine("tip-title", el.dataset.tip || "");
    const on = el.dataset.on;
    const off = el.dataset.off;
    if (on || off) {
      const active = el.classList.contains("active");
      addLine("tip-state", active ? "● Зараз: увімкнено" : "○ Зараз: вимкнено");
      if (on) addLine("tip-line" + (active ? " cur" : ""), on);
      if (off) addLine("tip-line" + (active ? "" : " cur"), off);
    } else if (el.dataset.desc) {
      addLine("tip-line", el.dataset.desc);
    }
    tip.classList.remove("hidden");
    position(el);
  };

  const hide = () => { current = null; tip.classList.add("hidden"); };

  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el && el !== current) show(el);
  });
  document.addEventListener("mouseout", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el && !el.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el) show(el);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("click", hide, true);
  if (els.chatLog) els.chatLog.addEventListener("scroll", hide);
}

// ---- Theme ----
const THEMES = ["auto", "dark", "light"];
const THEME_ICON = { auto: "🌓", dark: "🌙", light: "☀️" };
let themeIdx = 0;

function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  els.themeBtn.textContent = THEME_ICON[t] || "🌓";
}

function initTheme(stored) {
  themeIdx = Math.max(0, THEMES.indexOf(stored));
  applyTheme(THEMES[themeIdx]);
}

async function cycleTheme() {
  themeIdx = (themeIdx + 1) % THEMES.length;
  const t = THEMES[themeIdx];
  applyTheme(t);
  await chrome.storage.local.set({ theme: t });
}

// ---- Confirm actions toggle ----
async function toggleConfirm() {
  confirmActions = !confirmActions;
  els.confirmBtn.classList.toggle("active", confirmActions);
  await chrome.storage.local.set({ confirmActions });
  log("confirmActions:", confirmActions);
}

// ---- Macros (record / replay tool-call sequences) ----
function toggleRecord() {
  if (recording) {
    recording = false;
    els.recordBtn.classList.remove("active");
    const calls = recordedCalls.slice();
    recordedCalls = [];
    if (!calls.length) return;
    const name = (window.prompt(`Зберегти макрос (${calls.length} дій) як:`, "") || "").trim();
    if (name) saveMacro(name, calls);
  } else {
    recording = true;
    recordedCalls = [];
    els.recordBtn.classList.add("active");
  }
}

async function saveMacro(name, calls) {
  macros[name] = calls;
  await chrome.storage.local.set({ macros });
  populateMacros();
  els.macroSelect.value = name;
  updateMacroControls();
}

function populateMacros() {
  const names = Object.keys(macros);
  els.macroSelect.innerHTML = "";
  if (!names.length) {
    const opt = document.createElement("option");
    opt.textContent = "🎬 сценаріїв ще нема";
    opt.value = "";
    opt.disabled = true;
    els.macroSelect.appendChild(opt);
  } else {
    for (const n of names) {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = "▶ " + n;
      els.macroSelect.appendChild(opt);
    }
  }
  updateMacroControls();
}

function updateMacroControls() {
  const has = Object.keys(macros).length > 0;
  els.macroPlay.disabled = !has || busy;
  els.macroSelect.disabled = !has || busy;
}

function playSelectedMacro() {
  const name = els.macroSelect.value;
  if (name && macros[name]) runMacro(name, macros[name]);
}

// Replay a recorded sequence directly through the tools — no model in the loop.
async function runMacro(name, calls) {
  if (busy || !calls?.length) return;
  setBusy(true);
  setGroupState("busy");
  const typingEl = appendTyping();
  const onStep = (label) => {
    const el = document.createElement("div");
    el.className = "msg tool-log";
    el.textContent = "▶ " + label;
    els.chatLog.insertBefore(el, typingEl);
    scrollDown();
  };
  try {
    let n = 0;
    for (const c of calls) {
      if (stopRequested) break;
      onStep(Tools.label(c.name, c.args || {}));
      const r = await Tools.exec(c.name, c.args || {});
      if (r && r.error) onStep("⚠️ " + r.error);
      n++;
    }
    removeTyping(typingEl);
    appendMessage(`Макрос «${name}» відтворено (${n}/${calls.length} дій).`, "gemini");
    setGroupState("done");
  } catch (err) {
    removeTyping(typingEl);
    appendErrorMessage(err, null);
    setGroupState("error");
  } finally {
    stopRequested = false;
    setBusy(false);
  }
}

// ---- Settings ----
function showSettings(show) {
  els.settingsView.classList.toggle("hidden", !show);
  els.chatView.classList.toggle("hidden", show);
}

async function saveSettings() {
  const key = els.apiKeyInput.value.trim();
  const model = els.modelSelect.value;
  if (!key) { els.settingsStatus.textContent = "Введіть API ключ."; return; }

  // Validate the key with a live ListModels call before committing.
  els.saveSettingsBtn.disabled = true;
  els.settingsStatus.textContent = "Перевірка ключа…";
  try {
    await refreshModels(key); // throws on a bad key
  } catch (err) {
    els.saveSettingsBtn.disabled = false;
    const m = err?.status === 400 || err?.status === 403
      ? "Ключ недійсний або без доступу."
      : "Не вдалося перевірити ключ: " + (err?.message || err);
    els.settingsStatus.textContent = "✗ " + m;
    return;
  }

  settings.apiKey = key;
  // Keep the user's chosen model if it survived the refresh; else the select's.
  if (modelExists(model)) settings.model = model;
  els.modelSelect.value = settings.model;
  els.modelQuick.value = settings.model;
  await chrome.storage.local.set({ apiKey: key, model: settings.model });
  els.saveSettingsBtn.disabled = false;
  els.settingsStatus.textContent = "Ключ дійсний ✓";
  setTimeout(() => { els.settingsStatus.textContent = ""; showSettings(false); }, 800);
}

// ---- Images ----
function onPaste(e) {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.type.startsWith("image/")) {
      const file = it.getAsFile();
      if (file) addImageFiles([file]);
    }
  }
}

function addImageFiles(fileList) {
  for (const file of fileList) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result; // data:<mime>;base64,....
      const base64 = String(dataUrl).split(",")[1];
      pendingImages.push({ mimeType: file.type, data: base64, url: dataUrl });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
  els.fileInput.value = "";
}

function renderAttachments() {
  els.attachments.innerHTML = "";
  pendingImages.forEach((img, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    const im = document.createElement("img");
    im.src = img.url;
    const rm = document.createElement("button");
    rm.textContent = "×";
    rm.title = "Прибрати";
    rm.addEventListener("click", () => { pendingImages.splice(idx, 1); renderAttachments(); });
    wrap.append(im, rm);
    els.attachments.appendChild(wrap);
  });
}

// ---- Page context ----
// The 📄 button toggles whether the bound tab's content is attached to requests.
function toggleAutoContext() {
  autoContext = !autoContext;
  if (!autoContext) pageContext = null;
  updateContextBadge();
  log("autoContext:", autoContext);
}

function updateContextBadge() {
  els.contextBadge.classList.toggle("hidden", !autoContext);
  els.contextBtn.classList.toggle("active", autoContext);
}

// Toggle full eyes: attach/detach the debugger on the bound tab.
async function toggleEyes() {
  if (assistant.tabId == null) {
    appendMessage("Немає прив'язаної вкладки для очей.", "error");
    return;
  }
  try {
    if (eyesOn) {
      await Eyes.detach();
      eyesOn = false;
      log("eyes off");
    } else {
      await Eyes.attach(assistant.tabId);
      eyesOn = true;
      log("eyes on → tab", assistant.tabId);
    }
  } catch (err) {
    eyesOn = Eyes.isAttached(assistant.tabId);
    appendMessage("Не вдалося увімкнути очі: " + (err?.message || err), "error");
    log("toggleEyes failed:", err?.message || err);
  }
  els.eyesBtn.classList.toggle("active", eyesOn);
}

// Read the bound tab's URL, title and visible text. Scoped to the pinned tab,
// so switching tabs does not change what the assistant sees.
async function readPinnedTab() {
  if (assistant.tabId == null) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: assistant.tabId },
      func: () => ({
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || "").slice(0, 20000),
      }),
    });
    return res?.result || null;
  } catch (err) {
    log("readPinnedTab failed:", err?.message || err);
    return null;
  }
}

// ---- Chat ----
function clearChat() {
  history = [];
  transcript = [];
  pendingImages = [];
  pageContext = null;
  updateContextBadge();
  renderAttachments();
  els.chatLog.innerHTML = '<div class="msg gemini pop">Чисто! 🧹🐱 Про що поговоримо далі?</div>';
  updateSendButton();
  persistActive();
}

// ---- Sessions (persistent, multi-chat) ----
const WELCOME_HTML = '<div class="msg gemini">Мяу! 🐱 Я Діма — твій котик-помічник. Відкрий будь-яку сторінку й питай — підкажу, знайду, заповню форму чи натисну кнопку. З чого почнемо?</div>';

function newId() {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// History trimmed for storage: drop image bytes and keep only recent turns.
function persistableHistory() {
  return history.slice(-40).map((turn) => ({
    role: turn.role,
    parts: (turn.parts || []).filter(
      (p) => !(p.inlineData && /^image\//.test(p.inlineData.mimeType || ""))
    ),
  }));
}

function sessionTitle() {
  // A name the user typed wins; otherwise auto-name from the first message.
  const custom = sessions[sessionId]?.customTitle;
  if (custom) return custom;
  const firstUser = transcript.find((t) => t.role === "user" && t.text);
  if (firstUser) return firstUser.text.slice(0, 40);
  return "Нова розмова";
}

function persistActive() {
  if (!sessionId) return;
  sessions[sessionId] = {
    id: sessionId,
    title: sessionTitle(),
    customTitle: sessions[sessionId]?.customTitle || "",
    updatedAt: Date.now(),
    history: persistableHistory(),
    transcript: transcript.slice(-80),
  };
  chrome.storage.local.set({ sessions });
  setActiveSession();
  populateSessions();
}

// Record the active session FOR THIS WINDOW. The side panel is a separate
// instance per browser window, but chrome.storage is shared, so we keep a
// windowId -> sessionId map. A fresh window with no mapping starts its own
// chat instead of inheriting whatever was last active elsewhere.
async function currentWindowId() {
  try { return (await chrome.windows.getCurrent()).id ?? null; }
  catch { return null; }
}

async function setActiveSession() {
  if (!sessionId) return;
  const patch = { activeSessionId: sessionId }; // kept for backward-compat
  if (windowId != null) {
    const { windowSessions } = await chrome.storage.local.get("windowSessions");
    const map = windowSessions || {};
    map[windowId] = sessionId;
    patch.windowSessions = map;
  }
  await chrome.storage.local.set(patch);
}

// Drop windowId -> sessionId entries for windows that no longer exist, so the
// map doesn't grow without bound across a long browser run.
async function pruneWindowSessions() {
  try {
    const { windowSessions } = await chrome.storage.local.get("windowSessions");
    if (!windowSessions) return;
    const wins = await chrome.windows.getAll();
    const live = new Set(wins.map((w) => w.id));
    let changed = false;
    for (const k of Object.keys(windowSessions)) {
      if (!live.has(Number(k))) { delete windowSessions[k]; changed = true; }
    }
    if (changed) await chrome.storage.local.set({ windowSessions });
  } catch (_) {}
}

// Give the current conversation a custom name.
function renameSession() {
  if (!sessionId || busy) return;
  const cur = sessions[sessionId]?.customTitle || sessions[sessionId]?.title || "";
  const name = (window.prompt("Назва розмови:", cur) || "").trim();
  if (!name) return;
  sessions[sessionId].customTitle = name.slice(0, 60);
  sessions[sessionId].title = name.slice(0, 60);
  chrome.storage.local.set({ sessions });
  populateSessions();
}

// Delete the current conversation; fall back to another or a fresh one.
async function deleteSession() {
  if (!sessionId || busy) return;
  const name = sessions[sessionId]?.title || "цю розмову";
  if (!window.confirm(`Видалити «${name}»? Цю дію не скасувати.`)) return;
  delete sessions[sessionId];
  const rest = Object.values(sessions).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  await chrome.storage.local.set({ sessions });
  if (rest.length) {
    loadSessionInto(rest[0].id);
    setActiveSession();
    populateSessions();
  } else {
    await newSession(false);
  }
}

function loadSessionInto(id) {
  const s = sessions[id];
  if (!s) return;
  sessionId = id;
  history = (s.history || []).map((t) => ({ role: t.role, parts: (t.parts || []).slice() }));
  transcript = (s.transcript || []).slice();
  renderTranscript();
}

async function newSession(persistCurrent) {
  if (persistCurrent) persistActive();
  sessionId = newId();
  history = [];
  transcript = [];
  sessions[sessionId] = {
    id: sessionId,
    title: "Нова розмова",
    customTitle: "",
    updatedAt: Date.now(),
    history: [],
    transcript: [],
  };
  pendingImages = [];
  pageContext = null;
  renderAttachments();
  updateContextBadge();
  els.chatLog.innerHTML = WELCOME_HTML;
  updateSendButton();
  await chrome.storage.local.set({ sessions });
  await setActiveSession();
  populateSessions();
}

function switchSession(id) {
  if (busy) { els.sessionSelect.value = sessionId; return; } // no switch mid-request
  if (!id || id === sessionId) return;
  persistActive();
  loadSessionInto(id);
  setActiveSession();
  populateSessions();
}

function fmtDay(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("uk", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("uk", { day: "2-digit", month: "2-digit" });
}

function populateSessions() {
  const list = Object.values(sessions).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  els.sessionSelect.innerHTML = "";
  for (const s of list) {
    const opt = document.createElement("option");
    opt.value = s.id;
    const when = fmtDay(s.updatedAt);
    opt.textContent = `🐾 ${s.title || "Нова розмова"}${when ? " · " + when : ""}`;
    els.sessionSelect.appendChild(opt);
  }
  if (sessionId) els.sessionSelect.value = sessionId;
  // With a single conversation the switcher adds no value — collapse it to just
  // the ＋ button so the bar stays uncluttered until there's real history.
  const bar = els.sessionSelect.parentElement;
  if (bar) bar.classList.toggle("single", list.length <= 1);
}

// Rebuild the chat log from the saved display transcript.
function renderTranscript() {
  els.chatLog.innerHTML = "";
  if (!transcript.length) {
    els.chatLog.innerHTML = WELCOME_HTML;
    updateSendButton();
    return;
  }
  for (const item of transcript) {
    if (item.role === "user") {
      const div = document.createElement("div");
      div.className = "msg user";
      if (item.text) {
        const p = document.createElement("div");
        p.textContent = item.text;
        div.appendChild(p);
      }
      if (item.imgCount) {
        const note = document.createElement("div");
        note.className = "img-note";
        note.textContent = `🖼️ ${item.imgCount} зобр.`;
        div.appendChild(note);
      }
      els.chatLog.appendChild(div);
    } else {
      appendGemini(item.text, item.tokens);
    }
  }
  scrollDown();
  updateSendButton();
}

// Build a finished model bubble (used when restoring a saved transcript).
function appendGemini(text, tokens) {
  const div = document.createElement("div");
  div.className = "msg gemini";
  div.innerHTML = renderMarkdown(text);
  addCopyButtons(div, text);
  if (tokens) appendUsage(div, { totalTokenCount: tokens });
  els.chatLog.appendChild(div);
  return div;
}

async function onSend() {
  if (busy) return;
  const text = els.input.value.trim();
  if (!text && pendingImages.length === 0) return;

  if (!settings.apiKey) { showSettings(true); return; }

  // Auto-attach a fresh snapshot of the bound tab so the model sees the page.
  if (autoContext) {
    pageContext = await readPinnedTab();
    log("page context:", pageContext ? pageContext.url : "none");
  }

  // Eyes: screenshot (visual) + console/network (debugger).
  let eyesShot = null;
  let debugBlock = "";
  if (eyesOn) {
    const tab = await chrome.tabs.get(assistant.tabId).catch(() => null);
    if (tab?.active) eyesShot = await Eyes.screenshot(tab.windowId);
    debugBlock = Eyes.debugText();
    log("eyes: screenshot", !!eyesShot, "debug chars", debugBlock.length);
  }

  // Build parts for the API
  const parts = [];
  for (const img of pendingImages) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }
  if (eyesShot) parts.push({ inlineData: eyesShot });

  // Compose the context-augmented prompt.
  const ctx = [];
  if (pageContext) {
    ctx.push(
      `Current page context:\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\n` +
        `Text:\n"""${pageContext.text}"""`
    );
  }
  if (eyesShot) ctx.push("A screenshot of the current tab is attached.");
  if (debugBlock) ctx.push("DevTools data for this tab:\n" + debugBlock);

  const promptText = ctx.length
    ? ctx.join("\n\n") + `\n\n---\nUser request: ${text}`
    : text;
  if (promptText) parts.push({ text: promptText });

  // Render user bubble (show the typed text + thumbnails, not the injected context)
  renderUserBubble(text, pendingImages);
  transcript.push({ role: "user", text, imgCount: pendingImages.length });

  // Reset input/attachments
  els.input.value = "";
  pendingImages = [];
  renderAttachments();

  // The user bubble is already on screen; runTurn owns history + the API call.
  await runTurn(parts);
}

// Push a user turn, call the model, render reply or an error with retry.
// `parts` are reused as-is on retry, so nothing re-renders the user bubble.
async function runTurn(parts) {
  if (busy) return;
  const baseLen = history.length; // rollback point for the whole turn
  history.push({ role: "user", parts });

  setBusy(true);
  setGroupState("busy");
  const typingEl = appendTyping();

  // Each tool step becomes a persistent log line above the live typing dots;
  // the log stays in the chat after the turn finishes.
  const onStep = (label) => {
    const el = document.createElement("div");
    el.className = "msg tool-log";
    el.textContent = "🔧 " + label;
    els.chatLog.insertBefore(el, typingEl);
    scrollDown();
  };

  // Live streaming target: the typing bubble renders tokens as they arrive;
  // reset() flips it back to animated dots between model turns.
  let lastUsage = null;
  const live = {
    token: (text) => {
      stopDots(typingEl);
      typingEl.className = "msg gemini";
      typingEl.innerHTML = renderMarkdown(text);
      scrollDown();
    },
    reset: () => startDots(typingEl),
    usage: (u) => { if (u) lastUsage = u; },
    confirm: (fc) => requestConfirm(fc, typingEl),
  };

  try {
    const { text: reply, usage } = await callGemini(onStep, live);
    const u = usage || lastUsage;
    finalizeStream(typingEl, reply, u);
    history.push({ role: "model", parts: [{ text: reply }] });
    transcript.push({ role: "gemini", text: reply, tokens: u?.totalTokenCount || 0 });
    persistActive();
    setGroupState("done");
  } catch (err) {
    removeTyping(typingEl);
    if (err.keepHistory) {
      // Step limit: keep tool context so "Продовжити" resumes; no retry button.
      appendErrorMessage(err, null);
      persistActive(); // keep the tool context across reloads
      setGroupState("idle");
    } else {
      history.length = baseLen; // drop the user turn and any tool turns added
      if (err.stopped) {
        setGroupState("idle");
      } else {
        appendErrorMessage(err, parts);
        setGroupState("error");
      }
    }
  } finally {
    stopRequested = false;
    setBusy(false);
    els.input.focus();
  }
}

// Agentic browsing: the model calls browser tools (read_page/navigate/click)
// on the bound tab in a loop until it produces a final answer. A request is
// aborted only on a stall (no response for REQUEST_IDLE_MS) or a user Stop.
const MAX_TOOL_STEPS = 100;

const SYSTEM_PROMPT = `You are an autonomous browser agent embedded in a Chrome side panel. You control one bound browser tab and can perceive and act on it only through the tools below.

## Tools
- read_page(): current URL, title, visible text, links (text + href), interactive controls (inputs, <select> options with their values, checkboxes), and visible button labels.
- navigate(url): load an absolute URL in the tab, wait for load, return the new page.
- click(text): click the first link/button whose visible text contains \`text\`; returns the resulting page.
- type(text, into?): type into a field (optionally located by label/placeholder), return the page with any autocomplete suggestions.
- look(): capture a screenshot and SEE the rendered page. For UI not present in the page text (open dropdowns, custom widgets, visual state).
- read_console(): the tab's console logs and network requests; available only when the user has enabled eye mode.
- dom_map(): a structured list of everything you can act on RIGHT NOW — every clickable element's visible text, every option/menu-item/checkbox currently shown (with checked state), and every input with its label. Captures open dropdowns and filter overlays that read_page misses. This is how you SEE a widget's real choices.
- run_js(code): evaluate JavaScript in the page's main world and return the value — a last resort for acting on the DOM when the tools above cannot.

## How to work — think first, never guess
1. Act yourself with tools. Never tell the user to perform the steps manually.
2. START every task with a one-line plan: state the goal and the first filter/step. Then act. Re-plan in one line whenever a step surprises you.
3. NEVER guess. This means:
   - NEVER guess CSS selectors or element ids. On SPAs (Vue/React) ids like \`#v-4\`, \`v-7\` are auto-generated and meaningless — probing them wastes steps and always fails.
   - NEVER guess query-string params or API URLs (e.g. \`/api/search/...\`). You do not know the site's API; inventing endpoints returns garbage.
   - NEVER guess a filter's value. Open the filter, then READ the real options.
4. The reliable loop for any filter/widget:
   a. click("Region") (or the chip's visible label) to open it.
   b. dom_map() to SEE the exact options that appeared.
   c. click the option by its EXACT visible text from the map.
   d. verify with read_page() or dom_map() that it is applied.
5. Prefer click / type / dom_map over run_js. Reach for run_js ONLY when those genuinely cannot do it, and even then: first run_js that ENUMERATES (lists candidate texts), then act on a matched element — do not fire a guessed selector. After any DOM-changing run_js, call dom_map() or read_page().
6. Use look() sparingly (screenshots cost rate limit) — only for purely visual state no text tool exposes.
7. If a call errors or yields nothing useful, CHANGE approach — do not repeat the same or a near-identical call. Repeated probing of the same kind means your approach is wrong; step back and re-read with dom_map().
8. You have a limited step budget. Spend steps on observe→act→verify, not on blind trial. Keep going until you have the EXACT answer (e.g. a precise result count), then stop and report it.

## Output
Reply in the user's language (Ukrainian), concisely, and only once you have a factual result. If, after genuine attempts, you truly cannot obtain it, state what you tried and what blocked you — do not fabricate.`;

// Map an abort to the right error (user Stop vs idle stall).
function makeAbortError() {
  if (stopRequested) {
    const e = new Error("Зупинено користувачем.");
    e.stopped = true;
    return e;
  }
  const e = new Error(
    `Немає відповіді ${REQUEST_IDLE_MS / 1000} с. Модель перевантажена або ` +
      "недоступна — спробуйте ще раз або оберіть іншу модель."
  );
  e.retryable = true;
  return e;
}

const MAX_RETRIES = 4; // auto-retries on 429/503 (rate limit / overload)

// Extract Gemini's suggested retry delay (RetryInfo) from an error body, ms.
function retryDelayMs(body) {
  const err = Array.isArray(body) ? body[0]?.error : body?.error;
  const info = (err?.details || []).find((d) => /RetryInfo/.test(d["@type"] || ""));
  const m = /^(\d+)(?:\.\d+)?s$/.exec(info?.retryDelay || "");
  return m ? Number(m[1]) * 1000 + 500 : null;
}

function errMessage(body, fallback) {
  const err = Array.isArray(body) ? body[0]?.error : body?.error;
  return err?.message || fallback;
}

// Sleep that a user Stop can interrupt.
function abortableSleep(ms) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    currentController = controller;
    const t = setTimeout(() => { currentController = null; resolve(); }, ms);
    controller.signal.addEventListener("abort", () => {
      clearTimeout(t);
      currentController = null;
      reject(makeAbortError());
    });
  });
}

// Keep only the most recent screenshot in history — old images would be
// re-sent on every call and blow the tokens-per-minute limit (429 storms).
function pruneHistoryImages() {
  let lastImageTurn = -1;
  for (let i = 0; i < history.length; i++) {
    if ((history[i].parts || []).some((p) => /^image\//.test(p.inlineData?.mimeType || ""))) {
      lastImageTurn = i;
    }
  }
  for (let i = 0; i < history.length; i++) {
    if (i === lastImageTurn) continue;
    const t = history[i];
    if (t.parts) t.parts = t.parts.filter((p) => !/^image\//.test(p.inlineData?.mimeType || ""));
  }
}

// One streaming generateContent call with tools. Streams answer text through
// onToken(fullText); auto-retries on 429/503. Returns { parts, usage }.
// The idle watchdog aborts only when NO chunk arrives for REQUEST_IDLE_MS —
// each streamed chunk resets it, so a slow model that keeps producing tokens
// never hits the old 60s wall.
async function geminiStream(onToken, onInfo) {
  const url = `${API_BASE}/${encodeURIComponent(settings.model)}:streamGenerateContent?alt=sse`;
  pruneHistoryImages();
  const budget = THINKING_BUDGET[settings.model];

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    currentController = controller;
    let idle = setTimeout(() => controller.abort(), REQUEST_IDLE_MS);
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), REQUEST_IDLE_MS);
    };
    const t0 = Date.now();

    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": settings.apiKey },
        body: JSON.stringify({
          contents: history,
          tools: [{ function_declarations: Tools.declarations }],
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          ...(budget ? { generationConfig: { thinkingConfig: { thinkingBudget: budget } } } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(idle);
      currentController = null;
      if (err.name === "AbortError") throw makeAbortError();
      const e = new Error("Помилка мережі: " + (err?.message || err));
      e.retryable = true;
      throw e;
    }

    // Non-2xx: read the error body and maybe retry on rate limit / overload.
    if (!resp.ok) {
      clearTimeout(idle);
      currentController = null;
      let body = null;
      try { body = await resp.json(); } catch (_) {}
      if ((resp.status === 429 || resp.status === 503) && attempt < MAX_RETRIES) {
        const wait = Math.min(retryDelayMs(body) ?? 2000 * 2 ** attempt, 60000);
        log("rate-limited, retry in", wait, "ms");
        onInfo && onInfo(`⏳ ліміт запитів, чекаю ${Math.round(wait / 1000)} с…`);
        await abortableSleep(wait);
        continue;
      }
      throw buildApiError(resp.status, errMessage(body, `HTTP ${resp.status}`));
    }

    // Parse the Server-Sent Events stream: one JSON chunk per `data:` line.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let textAcc = "";
    const fcParts = [];
    let usage = null;
    let blockReason = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        resetIdle();
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (!json || json === "[DONE]") continue;
          let chunk;
          try { chunk = JSON.parse(json); } catch (_) { continue; }
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
          const cand = chunk.candidates?.[0];
          for (const part of cand?.content?.parts || []) {
            if (part.thought) continue; // don't surface the model's private thinking
            if (part.functionCall) {
              fcParts.push(part); // keep the whole part (preserves thoughtSignature)
            } else if (typeof part.text === "string") {
              textAcc += part.text;
              onToken && onToken(textAcc);
            }
          }
        }
      }
    } catch (err) {
      clearTimeout(idle);
      currentController = null;
      if (controller.signal.aborted) throw makeAbortError();
      const e = new Error("Обрив потоку: " + (err?.message || err));
      e.retryable = true;
      throw e;
    }
    clearTimeout(idle);
    currentController = null;
    log("stream done", `in ${Date.now() - t0}ms`, "tokens", usage?.totalTokenCount ?? "?");

    if (blockReason) throw new Error("Запит заблоковано: " + blockReason);
    const parts = [];
    if (textAcc) parts.push({ text: textAcc });
    for (const p of fcParts) parts.push(p);
    if (!parts.length) {
      const e = new Error("Порожня відповідь моделі.");
      e.retryable = true;
      throw e;
    }
    return { parts, usage };
  }
}

// Agentic loop: let the model call browser tools until it returns a final
// answer. onStep(label) logs each tool step as a persistent line in the chat.
const MUTATING = new Set(["click", "type", "navigate", "run_js"]);

async function callGemini(onStep, live) {
  const seen = new Map(); // tool-call signature -> count, to break loops
  let autoApprove = false; // "Завжди" within this turn skips later confirms

  for (let i = 0; i < MAX_TOOL_STEPS; i++) {
    live && live.reset(); // show the "typing" dots while this model turn streams
    const { parts, usage } = await geminiStream(live ? live.token : null, onStep);
    live && live.usage(usage);
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (calls.length) {
      // A tool turn: any streamed text was interim "thinking" — drop it so it
      // doesn't linger in the chat; the final answer streams on a later turn.
      live && live.reset();
      // Echo the model turn verbatim (keeps each part's thoughtSignature, which
      // Gemini 3+ requires), then run the tools and feed results back.
      history.push({ role: "model", parts });
      const responses = [];
      for (const fc of calls) {
        onStep && onStep(Tools.label(fc.name, fc.args));
        log("tool", fc.name, fc.args || {});

        // Loop guard: if the model repeats the exact same call, nudge instead
        // of executing it again.
        const sig = fc.name + ":" + JSON.stringify(fc.args || {});
        const n = (seen.get(sig) || 0) + 1;
        seen.set(sig, n);
        let result;
        if (n >= 3) {
          result = {
            error:
              "You already called this twice with identical arguments. Change your " +
              "approach (different URL/text/field) or give a final answer from the data you have.",
          };
        } else if (confirmActions && !autoApprove && MUTATING.has(fc.name) && live && live.confirm) {
          const decision = await live.confirm(fc);
          if (decision === "stop") { stopRequested = true; throw makeAbortError(); }
          if (decision === "deny") {
            result = {
              error:
                "Користувач відхилив цю дію. Не повторюй її — запропонуй інший підхід " +
                "або спитай користувача, що робити далі.",
            };
          } else {
            if (decision === "always") autoApprove = true;
            result = await Tools.exec(fc.name, fc.args || {});
            recordCall(fc);
          }
        } else {
          result = await Tools.exec(fc.name, fc.args || {});
          recordCall(fc);
        }
        // A screenshot can't live inside functionResponse — send it as an image
        // part in the same turn so the model actually sees the page.
        let image = null;
        if (result && result.image) { image = result.image; delete result.image; }
        responses.push({ functionResponse: { name: fc.name, response: result } });
        if (image) responses.push({ inlineData: image });
      }
      history.push({ role: "user", parts: responses });
      continue;
    }

    const text = parts.map((p) => p.text || "").join("").trim();
    if (text) return { text, usage };
    const e = new Error("Порожня відповідь моделі.");
    e.retryable = true;
    throw e;
  }

  const e = new Error(
    `Досягнуто ліміт кроків (${MAX_TOOL_STEPS}). Натисни «Продовжити», ` +
      "щоб агент продовжив з того місця."
  );
  e.keepHistory = true; // keep tool context so Continue resumes it
  throw e;
}

// Classify API failures so the UI can offer the right recovery action.
function buildApiError(status, detail) {
  const msg = String(detail || "");
  const overloaded =
    status === 429 ||
    status === 503 ||
    /high demand|overloaded|try again later|resource.?exhausted|unavailable/i.test(msg);

  const err = new Error(
    overloaded
      ? "Модель зараз перевантажена (високий попит). Спробуйте ще раз або оберіть іншу модель."
      : "Помилка: " + msg
  );
  err.status = status;
  err.retryable = overloaded;
  err.raw = `HTTP ${status}: ${msg}`; // original message for the details line
  return err;
}

// ---- Rendering ----
function renderUserBubble(text, images) {
  const div = document.createElement("div");
  div.className = "msg user";
  if (text) {
    const p = document.createElement("div");
    p.textContent = text;
    div.appendChild(p);
  }
  for (const img of images) {
    const im = document.createElement("img");
    im.src = img.url;
    div.appendChild(im);
  }
  els.chatLog.appendChild(div);
  scrollDown();
}

function appendMessage(text, sender) {
  const div = document.createElement("div");
  div.className = `msg ${sender}${sender === "gemini" ? " pop" : ""}`;
  if (sender === "gemini") {
    div.innerHTML = renderMarkdown(text); // safe: renderer escapes first
  } else {
    div.textContent = text;
  }
  els.chatLog.appendChild(div);
  scrollDown();
  return div;
}

// Error bubble with recovery actions: retry same model, or switch model + retry.
function appendErrorMessage(err, parts) {
  const retryable = err.retryable !== false; // plain/network errors are retryable too
  const text = /^(Помилка|Модель)/.test(err.message) ? err.message : "Помилка: " + err.message;

  const div = document.createElement("div");
  div.className = "msg error";
  const p = document.createElement("div");
  p.textContent = text;
  div.appendChild(p);

  // Original underlying message, so the real problem is visible.
  if (err.raw) {
    const raw = document.createElement("div");
    raw.className = "err-raw";
    raw.textContent = err.raw;
    div.appendChild(raw);
  }

  if (parts && retryable) {
    const actions = document.createElement("div");
    actions.className = "err-actions";
    actions.appendChild(makeErrBtn("↻ Повторити", () => retryTurn(div, parts)));

    // On overload, offer a one-click switch to each other model.
    if (err.retryable === true) {
      for (const m of models) {
        if (m.id === settings.model) continue;
        actions.appendChild(
          makeErrBtn("→ " + m.label, async () => {
            els.modelQuick.value = m.id;
            await onQuickModelChange();
            retryTurn(div, parts);
          })
        );
      }
    }
    div.appendChild(actions);
  }

  els.chatLog.appendChild(div);
  scrollDown();
  return div;
}

function makeErrBtn(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "err-btn";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function retryTurn(errDiv, parts) {
  if (busy) return;
  errDiv.remove();
  runTurn(parts);
}

function appendTyping() {
  const div = document.createElement("div");
  els.chatLog.appendChild(div);
  startDots(div);
  scrollDown();
  return div;
}

// Turn an element into the animated "друкую… Ns" indicator.
function startDots(div) {
  div.className = "msg gemini typing";
  div.innerHTML = "";
  if (!div._t0) div._t0 = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - div._t0) / 1000);
    div.textContent = s < 1 ? "друкую…" : `друкую… ${s}с`;
  };
  tick();
  if (div._timer) clearInterval(div._timer);
  div._timer = setInterval(tick, 1000);
}

function stopDots(div) {
  if (div?._timer) { clearInterval(div._timer); div._timer = null; }
  div?.classList.remove("typing");
}

function removeTyping(div) {
  if (div?._timer) clearInterval(div._timer);
  div?.remove();
}

// Convert the live streaming bubble into a finished model message: clean render
// + copy button + token note.
function finalizeStream(div, text, usage) {
  stopDots(div);
  div.className = "msg gemini";
  div.innerHTML = renderMarkdown(text);
  addCopyButtons(div, text);
  if (usage) appendUsage(div, usage);
  scrollDown();
}

// Copy affordances: one for the whole message, one per code block.
function addCopyButtons(div, rawText) {
  const btn = document.createElement("button");
  btn.className = "copy-msg";
  btn.title = "Копіювати відповідь";
  btn.textContent = "⧉";
  btn.addEventListener("click", () => copyText(rawText, btn));
  div.appendChild(btn);

  div.querySelectorAll("pre").forEach((pre) => {
    const b = document.createElement("button");
    b.className = "copy-code";
    b.title = "Копіювати код";
    b.textContent = "⧉";
    b.addEventListener("click", () => copyText(pre.innerText, b));
    pre.appendChild(b);
  });
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(
    () => {
      const old = btn.textContent;
      btn.textContent = "✓";
      setTimeout(() => { btn.textContent = old; }, 1000);
    },
    () => {}
  );
}

function appendUsage(div, usage) {
  const total = usage?.totalTokenCount;
  if (!total) return;
  const s = document.createElement("div");
  s.className = "tok";
  s.textContent = `~${total} токенів`;
  div.appendChild(s);
}

function setBusy(b) {
  busy = b;
  updateSendButton();
}

function hasModelTurn() {
  return history.some((h) => h.role === "model");
}

// Button mode: busy → Стоп; empty input → Продовжити; otherwise → Надіслати.
function updateSendButton() {
  const btn = els.sendBtn;
  els.modelQuick.disabled = busy; // no model switch mid-request
  updateMacroControls(); // disable play/select while a request or replay runs
  els.modelQuick.title = busy ? "Зачекайте завершення запиту" : "Модель";
  if (busy) {
    btn.dataset.mode = "stop";
    btn.textContent = "Стоп";
    btn.disabled = false;
  } else if (els.input.value.trim() === "") {
    btn.dataset.mode = "continue";
    btn.textContent = "Продовжити";
    btn.disabled = !hasModelTurn();
  } else {
    btn.dataset.mode = "send";
    btn.textContent = "Надіслати";
    btn.disabled = false;
  }
}

function onSendClick() {
  switch (els.sendBtn.dataset.mode) {
    case "stop": return stopGeneration();
    case "continue": return onContinue();
    default: return onSend();
  }
}

function stopGeneration() {
  if (!busy) return;
  stopRequested = true;
  // If a confirmation card is open, resolve it as a stop; otherwise abort the
  // in-flight stream.
  if (pendingConfirm) { pendingConfirm.resolve("stop"); return; }
  if (currentController) currentController.abort();
  log("stop requested");
}

// Render an inline approval card for a state-changing tool call and wait for the
// user's choice: "allow" | "deny" | "always" | "stop".
function requestConfirm(fc, anchorEl) {
  stopDots(anchorEl);
  return new Promise((resolve) => {
    const card = document.createElement("div");
    card.className = "msg confirm";

    const q = document.createElement("div");
    q.className = "confirm-q";
    q.textContent = "Дозволити дію агента?";
    const detail = document.createElement("div");
    detail.className = "confirm-detail";
    detail.textContent = Tools.label(fc.name, fc.args || {});
    card.append(q, detail);

    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const done = (decision) => {
      if (pendingConfirm !== holder) return;
      pendingConfirm = null;
      card.remove();
      startDots(anchorEl); // resume activity indicator
      resolve(decision);
    };
    const mk = (label, val, cls) => {
      const b = document.createElement("button");
      b.className = "confirm-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", () => done(val));
      return b;
    };
    actions.append(
      mk("✓ Дозволити", "allow", "ok"),
      mk("Завжди", "always"),
      mk("✕ Відхилити", "deny", "no")
    );
    card.appendChild(actions);

    els.chatLog.insertBefore(card, anchorEl);
    scrollDown();
    const holder = { resolve: done };
    pendingConfirm = holder;
  });
}

function recordCall(fc) {
  if (recording) recordedCalls.push({ name: fc.name, args: fc.args || {} });
}

// Continue the last answer where it left off (e.g. after Stop).
async function onContinue() {
  if (busy || !hasModelTurn()) return;
  log("continue");
  await runTurn([{ text: "Continue from where you left off." }]);
}

function scrollDown() {
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}
