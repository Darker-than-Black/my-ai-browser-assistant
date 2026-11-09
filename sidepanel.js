"use strict";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Single source of truth for selectable models (used by both selects).
const MODELS = [
  { id: "gemini-3.5-flash-lite", label: "Flash-Lite 3.5 (економна)" },
  { id: "gemini-3.8-flash", label: "Flash 3.8 (середня)" },
  { id: "gemini-4-argon", label: "Argon 4 (флагман)" },
];
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

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

// In-flight request controller, so the Stop button can abort it.
let currentController = null;
let stopRequested = false;

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

  const stored = await chrome.storage.local.get(["apiKey", "model"]);
  settings.apiKey = stored.apiKey || "";
  settings.model = modelExists(stored.model) ? stored.model : DEFAULT_MODEL;
  els.apiKeyInput.value = settings.apiKey;
  els.modelSelect.value = settings.model;
  els.modelQuick.value = settings.model;

  if (!settings.apiKey) showSettings(true);

  wireEvents();
  updateSendButton();
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
  Tools.bind(() => assistant.tabId);
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
  updateSendButton();
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

  try {
    const reply = await callGemini(onStep);
    removeTyping(typingEl);
    appendMessage(reply, "gemini");
    history.push({ role: "model", parts: [{ text: reply }] });
    setGroupState("done");
  } catch (err) {
    removeTyping(typingEl);
    history.length = baseLen; // drop the user turn and any tool turns added
    if (err.stopped) {
      setGroupState("idle");
    } else {
      appendErrorMessage(err, parts);
      setGroupState("error");
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
const MAX_TOOL_STEPS = 8;

const SYSTEM_PROMPT =
  "Ти — браузерний АГЕНТ у бічній панелі Chrome з прямим доступом до прив'язаної " +
  "вкладки через інструменти: read_page (вміст + посилання), navigate (перейти за " +
  "URL), click (клік по елементу за текстом). " +
  "Правила:\n" +
  "1. Виконуй задачу САМ через інструменти. НІКОЛИ не відповідай у стилі «зробіть це " +
  "самостійно» чи «виконайте кроки» — сам натискай фільтри, переходь і читай.\n" +
  "2. Фільтри на сайтах часто задаються через URL (query-параметри) — за потреби " +
  "формуй потрібний URL і використовуй navigate.\n" +
  "3. Продовжуй викликати інструменти, поки не отримаєш ТОЧНУ відповідь (напр. число " +
  "результатів). Прочитай текст сторінки результатів і назви точну цифру.\n" +
  "4. Якщо інструмент повернув error — спробуй інший шлях (інший текст для click, " +
  "прямий navigate), не здавайся після першої невдачі.\n" +
  "5. Відповідай українською, стисло, лише коли маєш фактичний результат.";

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

// One non-streaming generateContent call with tools; returns the candidate.
async function geminiOnce() {
  const url = `${API_BASE}/${encodeURIComponent(settings.model)}:generateContent`;
  const controller = new AbortController();
  currentController = controller;
  const idle = setTimeout(() => controller.abort(), REQUEST_IDLE_MS);
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
  } finally {
    clearTimeout(idle);
    currentController = null;
  }

  log("response", resp.status, `in ${Date.now() - t0}ms`);

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const e = await resp.json();
      detail = (Array.isArray(e) ? e[0]?.error?.message : e.error?.message) || detail;
    } catch (_) {}
    throw buildApiError(resp.status, detail);
  }

  const data = await resp.json();
  const cand = data.candidates?.[0];
  if (!cand) {
    if (data.promptFeedback?.blockReason) {
      throw new Error("Запит заблоковано: " + data.promptFeedback.blockReason);
    }
    const e = new Error("Порожня відповідь моделі.");
    e.retryable = true;
    throw e;
  }
  return cand;
}

// Agentic loop: let the model call browser tools until it returns a final
// answer. onStep(label) logs each tool step as a persistent line in the chat.
async function callGemini(onStep) {
  for (let i = 0; i < MAX_TOOL_STEPS; i++) {
    const cand = await geminiOnce();
    const parts = cand.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (calls.length) {
      // Echo the model turn verbatim (keeps each part's thoughtSignature, which
      // Gemini 3+ requires), then run the tools and feed results back.
      history.push({ role: "model", parts });
      const responses = [];
      for (const fc of calls) {
        onStep && onStep(Tools.label(fc.name, fc.args));
        log("tool", fc.name, fc.args || {});
        const result = await Tools.exec(fc.name, fc.args || {});
        responses.push({ functionResponse: { name: fc.name, response: result } });
      }
      history.push({ role: "user", parts: responses });
      continue;
    }

    const text = parts.map((p) => p.text || "").join("").trim();
    if (text) return text;
    const e = new Error("Порожня відповідь моделі.");
    e.retryable = true;
    throw e;
  }

  const e = new Error(
    `Досягнуто ліміт кроків (${MAX_TOOL_STEPS}). Уточни запит або спробуй ще раз.`
  );
  e.retryable = true;
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
  updateSendButton();
}

function hasModelTurn() {
  return history.some((h) => h.role === "model");
}

// Button mode: busy → Стоп; empty input → Продовжити; otherwise → Надіслати.
function updateSendButton() {
  const btn = els.sendBtn;
  els.modelQuick.disabled = busy; // no model switch mid-request
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
  if (!busy || !currentController) return;
  stopRequested = true;
  currentController.abort();
  log("stop requested");
}

// Continue the last answer where it left off (e.g. after Stop).
async function onContinue() {
  if (busy || !hasModelTurn()) return;
  log("continue");
  await runTurn([{ text: "Продовжуй відповідь з місця, де зупинився." }]);
}

function scrollDown() {
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}
