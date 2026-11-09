"use strict";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Single source of truth for selectable models (used by both selects).
const MODELS = [
  { id: "gemini-3.8-flash", label: "Flash 3.8 (швидка)" },
  { id: "gemini-4-argon", label: "Argon 4 (флагман)" },
  { id: "gemini-3.5-flash-lite", label: "Flash-Lite 3.5 (економна)" },
];
const DEFAULT_MODEL = "gemini-3.8-flash";

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
};

// ---- State ----
let settings = { apiKey: "", model: DEFAULT_MODEL };
let history = []; // [{ role: 'user'|'model', parts: [...] }]
let pendingImages = []; // [{ mimeType, data(base64), url }]
let pageContext = null; // { url, title, text } or null
let busy = false;

// Assistant tab group: scopes the assistant to one browser window and shows
// request status in the group title. title-only (Chrome tab groups have no
// icon field), so status is signalled with an emoji prefix.
const GROUP_NAME = "My assistant";
const GROUP_STATES = {
  idle: GROUP_NAME,
  busy: "⏳ " + GROUP_NAME,
  done: "✅ " + GROUP_NAME,
  error: "⚠️ " + GROUP_NAME,
};
let assistant = { groupId: null, windowId: null, tabId: null };

// Auto-read the bound tab's page on every send so the model "sees" the page
// without a manual toggle. Can be turned off with the 📄 button.
let autoContext = true;

// "Eyes": attach the debugger to the bound tab for console + network, and send
// a screenshot with each request. Off by default (debugger shows a banner).
let eyesOn = false;

// Abort only if the stream stalls (no bytes) for this long — not a total-time
// cap, so slow-but-progressing answers are never cut off.
const REQUEST_IDLE_MS = 45000;

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

  const stored = await chrome.storage.local.get(["apiKey", "model"]);
  settings.apiKey = stored.apiKey || "";
  settings.model = modelExists(stored.model) ? stored.model : DEFAULT_MODEL;
  els.apiKeyInput.value = settings.apiKey;
  els.modelSelect.value = settings.model;
  els.modelQuick.value = settings.model;

  if (!settings.apiKey) showSettings(true);

  wireEvents();
  await resolveBoundTab();
  ensureAssistantGroup();
  updateContextBadge();
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
}

// ---- Assistant tab group ----
// Group the current tab into a "My assistant" group so the assistant is bound
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
async function setGroupState(state) {
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
  return MODELS.some((m) => m.id === id);
}

function populateModelSelects() {
  for (const sel of [els.modelSelect, els.modelQuick]) {
    sel.innerHTML = "";
    for (const m of MODELS) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      sel.appendChild(opt);
    }
  }
}

// Switch model from the chat bar without opening settings. Persists immediately.
async function onQuickModelChange() {
  settings.model = els.modelQuick.value;
  els.modelSelect.value = settings.model;
  await chrome.storage.local.set({ model: settings.model });
}

function wireEvents() {
  els.sendBtn.addEventListener("click", onSend);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  els.input.addEventListener("paste", onPaste);

  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => addImageFiles(e.target.files));

  els.contextBtn.addEventListener("click", toggleAutoContext);
  els.eyesBtn.addEventListener("click", toggleEyes);
  window.addEventListener("pagehide", () => { if (eyesOn) Eyes.detach(); });
  els.clearBtn.addEventListener("click", clearChat);
  els.settingsBtn.addEventListener("click", () => showSettings(els.settingsView.classList.contains("hidden")));
  els.saveSettingsBtn.addEventListener("click", saveSettings);
  els.modelQuick.addEventListener("change", onQuickModelChange);
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
  settings.apiKey = key;
  settings.model = model;
  els.modelQuick.value = model;
  await chrome.storage.local.set({ apiKey: key, model });
  els.settingsStatus.textContent = "Збережено ✓";
  setTimeout(() => { els.settingsStatus.textContent = ""; showSettings(false); }, 700);
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
  pendingImages = [];
  pageContext = null;
  updateContextBadge();
  renderAttachments();
  els.chatLog.innerHTML = '<div class="msg gemini">Чат очищено. Чим можу допомогти?</div>';
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
      `Контекст активної сторінки:\nURL: ${pageContext.url}\nЗаголовок: ${pageContext.title}\n` +
        `Текст:\n"""${pageContext.text}"""`
    );
  }
  if (eyesShot) ctx.push("До запиту додано скриншот поточної вкладки.");
  if (debugBlock) ctx.push("Дані DevTools цієї вкладки:\n" + debugBlock);

  const promptText = ctx.length
    ? ctx.join("\n\n") + `\n\n---\nЗапит користувача: ${text}`
    : text;
  if (promptText) parts.push({ text: promptText });

  // Render user bubble (show the typed text + thumbnails, not the injected context)
  renderUserBubble(text, pendingImages);

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
  history.push({ role: "user", parts });

  setBusy(true);
  setGroupState("busy");
  const typingEl = appendTyping();
  let bubble = null;

  // Render streamed text into a single gemini bubble, replacing the typing dots
  // on the first chunk.
  const onDelta = (full) => {
    if (!bubble) {
      removeTyping(typingEl);
      bubble = appendMessage("", "gemini");
    }
    bubble.innerHTML = renderMarkdown(full);
    scrollDown();
  };

  try {
    const reply = await callGemini(onDelta);
    if (!bubble) { removeTyping(typingEl); bubble = appendMessage(reply, "gemini"); }
    else bubble.innerHTML = renderMarkdown(reply);
    history.push({ role: "model", parts: [{ text: reply }] });
    setGroupState("done");
  } catch (err) {
    removeTyping(typingEl);
    if (bubble) bubble.remove();
    // Roll back the failed user turn so retry/history stays clean
    history.pop();
    appendErrorMessage(err, parts);
    setGroupState("error");
  } finally {
    setBusy(false);
    els.input.focus();
  }
}

// Stream the model response (SSE). Calls onDelta(fullTextSoFar) as chunks
// arrive and returns the final text. Aborts only on a stall (no bytes for
// REQUEST_IDLE_MS), so a slow-but-progressing answer is never cut off.
async function callGemini(onDelta) {
  const url =
    `${API_BASE}/${encodeURIComponent(settings.model)}:streamGenerateContent?alt=sse`;

  const controller = new AbortController();
  let idle;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), REQUEST_IDLE_MS);
  };
  const t0 = Date.now();
  resetIdle();
  log("stream →", settings.model, `(${history.length} turns)`);

  const timeoutError = () => {
    const e = new Error(
      `Немає відповіді ${REQUEST_IDLE_MS / 1000} с. Модель перевантажена або ` +
        "недоступна — спробуйте ще раз або оберіть іншу модель."
    );
    e.retryable = true;
    return e;
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": settings.apiKey,
      },
      body: JSON.stringify({ contents: history }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(idle);
    if (err.name === "AbortError") { log("connect stalled"); throw timeoutError(); }
    log("network error:", err?.message || err);
    const e = new Error("Помилка мережі: " + (err?.message || err));
    e.retryable = true;
    throw e;
  }

  log("response", resp.status, `in ${Date.now() - t0}ms`);

  if (!resp.ok) {
    clearTimeout(idle);
    let detail = `HTTP ${resp.status}`;
    try {
      const e = await resp.json();
      detail = (Array.isArray(e) ? e[0]?.error?.message : e.error?.message) || detail;
    } catch (_) {}
    throw buildApiError(resp.status, detail);
  }

  // Parse the SSE body: lines of `data: {json}` separated by newlines.
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let blocked = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let obj;
        try { obj = JSON.parse(payload); } catch (_) { continue; }
        if (obj.promptFeedback?.blockReason) blocked = obj.promptFeedback.blockReason;
        const txt = (obj.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || "")
          .join("");
        if (txt) { full += txt; onDelta && onDelta(full); }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") { log("stream stalled"); throw timeoutError(); }
    throw err;
  } finally {
    clearTimeout(idle);
  }

  log("stream done", `${Date.now() - t0}ms`, `${full.length} chars`);

  const out = full.trim();
  if (!out) {
    if (blocked) throw new Error("Запит заблоковано: " + blocked);
    const e = new Error("Порожня відповідь моделі.");
    e.retryable = true;
    throw e;
  }
  return out;
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
  div.className = `msg ${sender}`;
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

  if (parts && retryable) {
    const actions = document.createElement("div");
    actions.className = "err-actions";
    actions.appendChild(makeErrBtn("↻ Повторити", () => retryTurn(div, parts)));

    // On overload, offer a one-click switch to each other model.
    if (err.retryable === true) {
      for (const m of MODELS) {
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
  div.className = "msg gemini typing";
  const t0 = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    div.textContent = s < 1 ? "друкую…" : `друкую… ${s}с`;
  };
  tick();
  div._timer = setInterval(tick, 1000);
  els.chatLog.appendChild(div);
  scrollDown();
  return div;
}

function removeTyping(div) {
  if (div?._timer) clearInterval(div._timer);
  div?.remove();
}

function setBusy(b) {
  busy = b;
  els.sendBtn.disabled = b;
  els.sendBtn.textContent = b ? "…" : "Надіслати";
}

function scrollDown() {
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}
