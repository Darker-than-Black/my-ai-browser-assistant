"use strict";

// "Eyes" for the assistant: captures a screenshot (always available) and, when
// the debugger is attached, the tab's console messages and network requests.
// Exposes a small global `Eyes` used by sidepanel.js.

const Eyes = (() => {
  const MAX_CONSOLE = 40;
  const MAX_NETWORK = 40;
  const PROTOCOL = "1.3";

  let attachedTabId = null;
  const consoleLog = []; // { level, text }
  const netInflight = new Map(); // requestId -> { method, url, status }
  const netLog = []; // { method, url, status, failed }

  function push(arr, item, cap) {
    arr.push(item);
    if (arr.length > cap) arr.shift();
  }

  // ---- Debugger lifecycle ----
  function isAttached(tabId) {
    return attachedTabId === tabId;
  }

  async function attach(tabId) {
    if (attachedTabId === tabId) return;
    if (attachedTabId != null) await detach();
    await chrome.debugger.attach({ tabId }, PROTOCOL);
    attachedTabId = tabId;
    chrome.debugger.onEvent.addListener(onEvent);
    chrome.debugger.onDetach.addListener(onDetach);
    await send(tabId, "Runtime.enable");
    await send(tabId, "Log.enable");
    await send(tabId, "Network.enable");
  }

  async function detach() {
    const tabId = attachedTabId;
    attachedTabId = null;
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    clear();
    if (tabId != null) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    }
  }

  function send(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res);
      });
    });
  }

  function onDetach(source) {
    if (source.tabId === attachedTabId) {
      attachedTabId = null; // e.g. user closed the banner or DevTools opened
    }
  }

  // ---- Event capture ----
  function onEvent(source, method, params) {
    if (source.tabId !== attachedTabId) return;
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const level = params.type || "log";
        const text = (params.args || []).map(remoteToStr).join(" ");
        push(consoleLog, { level, text }, MAX_CONSOLE);
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails || {};
        const text = d.exception?.description || d.text || "Exception";
        push(consoleLog, { level: "error", text }, MAX_CONSOLE);
        break;
      }
      case "Log.entryAdded": {
        const e = params.entry || {};
        push(consoleLog, { level: e.level || "info", text: e.text || "" }, MAX_CONSOLE);
        break;
      }
      case "Network.requestWillBeSent": {
        const r = params.request || {};
        netInflight.set(params.requestId, { method: r.method, url: r.url, status: null });
        break;
      }
      case "Network.responseReceived": {
        const rec = netInflight.get(params.requestId);
        if (rec) rec.status = params.response?.status ?? null;
        break;
      }
      case "Network.loadingFinished": {
        const rec = netInflight.get(params.requestId);
        if (rec) { push(netLog, rec, MAX_NETWORK); netInflight.delete(params.requestId); }
        break;
      }
      case "Network.loadingFailed": {
        const rec = netInflight.get(params.requestId);
        if (rec) {
          rec.failed = true;
          rec.errorText = params.errorText;
          push(netLog, rec, MAX_NETWORK);
          netInflight.delete(params.requestId);
        }
        break;
      }
    }
  }

  function remoteToStr(arg) {
    if (arg == null) return "";
    if (arg.value !== undefined) return String(arg.value);
    if (arg.description) return arg.description;
    if (arg.type === "undefined") return "undefined";
    return arg.unserializableValue || arg.type || "";
  }

  function clear() {
    consoleLog.length = 0;
    netLog.length = 0;
    netInflight.clear();
  }

  // ---- Snapshots for the prompt ----
  // Visible-tab screenshot as base64 JPEG, or null if the tab isn't capturable.
  async function screenshot(windowId) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 55,
      });
      return { mimeType: "image/jpeg", data: String(dataUrl).split(",")[1] };
    } catch (_) {
      return null; // tab not active/visible, or permission not granted
    }
  }

  // Compact text block of recent console + network for the prompt.
  function debugText() {
    if (attachedTabId == null) return "";
    const lines = [];
    if (consoleLog.length) {
      lines.push("=== Консоль (останні) ===");
      for (const c of consoleLog) lines.push(`[${c.level}] ${trunc(c.text, 300)}`);
    }
    if (netLog.length) {
      lines.push("=== Мережа (останні) ===");
      for (const n of netLog) {
        const st = n.failed ? `FAILED ${n.errorText || ""}` : n.status ?? "?";
        lines.push(`${n.method} ${trunc(n.url, 160)} → ${st}`);
      }
    }
    return lines.join("\n");
  }

  function trunc(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  return { attach, detach, isAttached, screenshot, debugText, get tabId() { return attachedTabId; } };
})();
