"use strict";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ---- DOM ----
const els = {
  chatLog: document.getElementById("chat-log"),
  input: document.getElementById("user-input"),
  sendBtn: document.getElementById("send-btn"),
  attachBtn: document.getElementById("attach-btn"),
  fileInput: document.getElementById("file-input"),
  attachments: document.getElementById("attachments"),
  contextBtn: document.getElementById("context-btn"),
  contextBadge: document.getElementById("context-badge"),
  clearBtn: document.getElementById("clear-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsView: document.getElementById("settings-view"),
  chatView: document.getElementById("chat-view"),
  apiKeyInput: document.getElementById("api-key-input"),
  modelSelect: document.getElementById("model-select"),
  saveSettingsBtn: document.getElementById("save-settings-btn"),
  settingsStatus: document.getElementById("settings-status"),
};

// ---- State ----
let settings = { apiKey: "", model: "gemini-3.8-flash" };
let history = []; // [{ role: 'user'|'model', parts: [...] }]
let pendingImages = []; // [{ mimeType, data(base64), url }]
let pageContext = null; // { url, title, text } or null
let busy = false;

// ---- Init ----
init();

async function init() {
  const stored = await chrome.storage.local.get(["apiKey", "model"]);
  settings.apiKey = stored.apiKey || "";
  settings.model = stored.model || "gemini-3.8-flash";
  els.apiKeyInput.value = settings.apiKey;
  els.modelSelect.value = settings.model;

  if (!settings.apiKey) showSettings(true);

  wireEvents();
}

function wireEvents() {
  els.sendBtn.addEventListener("click", onSend);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  els.input.addEventListener("paste", onPaste);

  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => addImageFiles(e.target.files));

  els.contextBtn.addEventListener("click", togglePageContext);
  els.clearBtn.addEventListener("click", clearChat);
  els.settingsBtn.addEventListener("click", () => showSettings(els.settingsView.classList.contains("hidden")));
  els.saveSettingsBtn.addEventListener("click", saveSettings);
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
async function togglePageContext() {
  if (pageContext) { pageContext = null; updateContextBadge(); return; }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Немає активної вкладки");
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || "").slice(0, 20000),
      }),
    });
    pageContext = res.result;
    updateContextBadge();
  } catch (err) {
    appendMessage("Не вдалося прочитати сторінку: " + err.message, "error");
  }
}

function updateContextBadge() {
  els.contextBadge.classList.toggle("hidden", !pageContext);
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

  // Build parts for the API
  const parts = [];
  for (const img of pendingImages) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }
  let promptText = text;
  if (pageContext) {
    promptText =
      `Контекст активної сторінки:\nURL: ${pageContext.url}\nЗаголовок: ${pageContext.title}\n` +
      `Текст:\n"""${pageContext.text}"""\n\n---\nЗапит користувача: ${text}`;
  }
  if (promptText) parts.push({ text: promptText });

  // Render user bubble (show the typed text + thumbnails, not the injected context)
  renderUserBubble(text, pendingImages);

  history.push({ role: "user", parts });

  // Reset input/attachments
  els.input.value = "";
  const sentImages = pendingImages;
  pendingImages = [];
  renderAttachments();

  setBusy(true);
  const typingEl = appendTyping();

  try {
    const reply = await callGemini();
    typingEl.remove();
    history.push({ role: "model", parts: [{ text: reply }] });
    appendMessage(reply, "gemini");
  } catch (err) {
    typingEl.remove();
    // Roll back the failed user turn so retry/history stays clean
    history.pop();
    appendMessage("Помилка: " + err.message, "error");
  } finally {
    setBusy(false);
    els.input.focus();
  }
}

async function callGemini() {
  const url = `${API_BASE}/${encodeURIComponent(settings.model)}:generateContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": settings.apiKey,
    },
    body: JSON.stringify({ contents: history }),
  });

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const e = await resp.json();
      detail = e.error?.message || detail;
    } catch (_) {}
    throw new Error(detail);
  }

  const data = await resp.json();
  const cand = data.candidates?.[0];
  if (!cand) {
    if (data.promptFeedback?.blockReason) {
      throw new Error("Запит заблоковано: " + data.promptFeedback.blockReason);
    }
    throw new Error("Порожня відповідь моделі.");
  }
  const reply = (cand.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
  return reply || "(модель повернула порожню відповідь)";
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

function appendTyping() {
  const div = document.createElement("div");
  div.className = "msg gemini typing";
  div.textContent = "друкую…";
  els.chatLog.appendChild(div);
  scrollDown();
  return div;
}

function setBusy(b) {
  busy = b;
  els.sendBtn.disabled = b;
  els.sendBtn.textContent = b ? "…" : "Надіслати";
}

function scrollDown() {
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}
