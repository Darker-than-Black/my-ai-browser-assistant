"use strict";

// Browser tools exposed to Gemini (function calling). All operate on the tab
// the assistant is bound to. The executor runs in the side panel and uses
// chrome.scripting / chrome.tabs, which require <all_urls> host permission to
// work across navigations.
const Tools = (() => {
  const LINK_CAP = 120;
  const TEXT_CAP = 8000;
  const LOAD_TIMEOUT = 20000;

  let getTabId = () => null; // injected by sidepanel.js

  function bind(fn) { getTabId = fn; }

  // ---- Gemini function declarations ----
  const declarations = [
    {
      name: "read_page",
      description:
        "Read the bound tab: URL, title, visible text, links (text + href), interactive controls (inputs, select options with values, checkboxes), and visible button labels. Use first to understand the page and where you can go.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "navigate",
      description:
        "Navigate the bound tab to an absolute URL, wait for load, and return the new page content.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Full URL, e.g. https://..." } },
        required: ["url"],
      },
    },
    {
      name: "click",
      description:
        "Click the first link/button whose visible text contains the given substring, wait for load, and return the new page content.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Part of the element's visible text" } },
        required: ["text"],
      },
    },
    {
      name: "type",
      description:
        "Type text into an input field (search/filter) and return the updated page including any autocomplete suggestions that appear. Click first if you need to open the field.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type" },
          into: {
            type: "string",
            description: "Part of the field's label/placeholder; leave empty for the active or first visible field",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "look",
      description:
        "Take a screenshot and SEE the page visually. Use when the needed elements are not in the page text/controls: e.g. after clicking a filter, to see the dropdown options and then click the right one by text.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "read_console",
      description:
        "Read the tab's console logs and network requests (JS errors, API calls). Works only when eye mode is enabled (the 👁️ button).",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "dom_map",
      description:
        "Return a structured map of what you can act on RIGHT NOW: every clickable element's visible text, every option/menu-item/checkbox/radio currently shown (with checked state and value), and every input with its label and value. Captures open dropdowns and filter overlays that read_page misses. Call this after opening a filter to SEE its real options, then click the one you want by its exact text. Never guess options — read them here.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "run_js",
      description:
        "Last resort: run a JavaScript expression in the page's MAIN world and return its value. Prefer click/type/dom_map. Use only when those cannot act on a widget. Do NOT fire guessed selectors or ids (SPA ids like #v-4 are auto-generated); instead first ENUMERATE candidates (list element texts) then act on a match. Requires eye mode (👁️). After a call that changes the DOM, follow with dom_map or read_page.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "A JS expression to evaluate, e.g. document.querySelectorAll('.tender').length",
          },
        },
        required: ["code"],
      },
    },
  ];

  // ---- Page snapshot (runs in the page) ----
  function pageSnapshotFn(linkCap, textCap) {
    const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;

    const links = [...document.querySelectorAll("a[href]")]
      .map((a) => ({
        text: (a.innerText || a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
        href: a.href,
      }))
      .filter((l) => l.text && /^https?:/.test(l.href))
      .slice(0, linkCap);

    // Interactive controls, so the agent sees exact filter values instead of
    // guessing them (e.g. <select> option values = region/category codes).
    const controls = [];
    const nodes = document.querySelectorAll(
      'input:not([type=hidden]), textarea, select, [role=checkbox], [role=combobox], [contenteditable=true]'
    );
    for (const el of nodes) {
      if (controls.length >= 60 || !visible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const label = (el.getAttribute("aria-label") || el.placeholder || el.name || el.id || "")
        .toString().trim().slice(0, 60);
      if (tag === "select") {
        const options = [...el.options].slice(0, 25).map((o) => ({
          value: o.value,
          text: (o.text || "").trim().slice(0, 50),
        }));
        controls.push({ type: "select", label, value: el.value, options });
      } else if (el.type === "checkbox" || el.type === "radio" || el.getAttribute("role") === "checkbox") {
        controls.push({
          type: el.type || "checkbox",
          label,
          value: el.value || "",
          checked: el.checked || el.getAttribute("aria-checked") === "true",
        });
      } else {
        controls.push({
          type: el.type || tag,
          label,
          placeholder: el.placeholder || "",
          value: (el.value || el.textContent || "").toString().slice(0, 40),
        });
      }
    }

    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map((b) => (b.innerText || b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50))
      .filter(Boolean)
      .slice(0, 40);

    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, textCap),
      links,
      controls,
      buttons,
    };
  }

  async function snapshot(tabId) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageSnapshotFn,
      args: [LINK_CAP, TEXT_CAP],
    });
    return res?.result || { error: "Failed to read the page" };
  }

  // ---- Interactive map (runs in the page) ----
  // Lists actionable TEXT targets currently on screen — including options in an
  // open dropdown/overlay — so the agent reads real choices instead of guessing
  // selectors or option values.
  function domMapFn() {
    const vis = (el) =>
      (el.offsetParent !== null || el.getClientRects().length > 0) &&
      getComputedStyle(el).visibility !== "hidden";
    const txt = (el) =>
      (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70);

    // Clickable targets (shallow text only, so a wrapper doesn't swallow its
    // children's labels).
    const clickSeen = new Set();
    const clickable = [];
    for (const el of document.querySelectorAll(
      'button, a[href], [role=button], [role=tab], [onclick], summary, [class*=chip i], [class*=filter i]'
    )) {
      if (clickable.length >= 70 || !vis(el)) continue;
      let t = "";
      for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
      t = (t.trim() || txt(el)).replace(/\s+/g, " ").slice(0, 70);
      if (!t || clickSeen.has(t)) continue;
      clickSeen.add(t);
      clickable.push(t);
    }

    // Choices currently shown (dropdown/overlay options, checkboxes, radios).
    const optSeen = new Set();
    const options = [];
    for (const el of document.querySelectorAll(
      '[role=option], [role=menuitem], [role=radio], [role=checkbox], li, label, option'
    )) {
      if (options.length >= 80 || !vis(el)) continue;
      const t = txt(el);
      if (!t || t.length > 70 || optSeen.has(t)) continue;
      const input = el.matches("option")
        ? el
        : el.querySelector("input[type=checkbox],input[type=radio]");
      const checked =
        el.getAttribute("aria-checked") === "true" ||
        el.getAttribute("aria-selected") === "true" ||
        (input && (input.checked || input.selected));
      optSeen.add(t);
      options.push(checked ? { text: t, checked: true } : { text: t });
    }

    // Inputs with their labels/values.
    const inputs = [];
    for (const el of document.querySelectorAll(
      'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]'
    )) {
      if (inputs.length >= 40 || !vis(el)) continue;
      inputs.push({
        label: (el.getAttribute("aria-label") || el.placeholder || el.name || el.id || "")
          .toString().trim().slice(0, 60),
        value: (el.value || el.textContent || "").toString().trim().slice(0, 50),
      });
    }

    return { url: location.href, title: document.title, clickable, options, inputs };
  }

  async function domMap(tabId) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: domMapFn,
    });
    return res?.result || { error: "Failed to map the page" };
  }

  function waitComplete(tabId) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(to);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
      const to = setTimeout(finish, LOAD_TIMEOUT);
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId, (t) => { if (!chrome.runtime.lastError && t?.status === "complete") finish(); });
    });
  }

  // ---- Executor ----
  async function exec(name, args) {
    const tabId = getTabId();
    if (tabId == null) return { error: "No bound tab" };
    try {
      switch (name) {
        case "read_page":
          return await snapshot(tabId);

        case "dom_map":
          return await domMap(tabId);

        case "navigate": {
          const url = String(args?.url || "");
          if (!/^https?:\/\//.test(url)) return { error: "A full URL (https://...) is required" };
          await chrome.tabs.update(tabId, { url });
          await waitComplete(tabId);
          return await snapshot(tabId);
        }

        case "click": {
          const text = String(args?.text || "");
          const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (txt) => {
              const needle = txt.toLowerCase();
              const el = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')]
                .find((e) => ((e.innerText || e.textContent || e.value || "").trim().toLowerCase().includes(needle)));
              if (!el) return { clicked: false };
              el.click();
              return { clicked: true, text: (el.innerText || el.textContent || "").trim().slice(0, 80) };
            },
            args: [text],
          });
          const r = res?.result || { clicked: false };
          if (!r.clicked) return { clicked: false, error: `No element containing text "${text}" found` };
          await waitComplete(tabId);
          await new Promise((rsv) => setTimeout(rsv, 500)); // let SPA render (dropdowns, etc.)
          return { clicked: true, clickedText: r.text, page: await snapshot(tabId) };
        }

        case "type": {
          const text = String(args?.text || "");
          const into = String(args?.into || "");
          const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (txt, hint) => {
              const vis = [...document.querySelectorAll(
                'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]'
              )].filter((e) => e.offsetParent !== null);
              let el = null;
              if (hint) {
                const n = hint.toLowerCase();
                el = vis.find((e) =>
                  ((e.getAttribute("aria-label") || e.placeholder || e.name || e.id || "")
                    .toLowerCase().includes(n))
                );
              }
              if (!el && vis.includes(document.activeElement)) el = document.activeElement;
              if (!el) el = vis[0];
              if (!el) return { typed: false };
              el.focus();
              if (el.isContentEditable) {
                el.textContent = txt;
              } else {
                const setter = Object.getOwnPropertyDescriptor(
                  el.constructor.prototype, "value"
                )?.set;
                if (setter) setter.call(el, txt); else el.value = txt;
              }
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              const k = txt.slice(-1) || "a";
              el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: k }));
              el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: k }));
              return { typed: true, field: (el.getAttribute("aria-label") || el.placeholder || el.name || "").slice(0, 60) };
            },
            args: [text, into],
          });
          const r = res?.result || { typed: false };
          if (!r.typed) return { typed: false, error: "No input field found" };
          await new Promise((rsv) => setTimeout(rsv, 800)); // let suggestions load
          return { typed: true, field: r.field, page: await snapshot(tabId) };
        }

        case "look": {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (!tab) return { error: "Tab unavailable" };
          if (!tab.active) {
            return { error: "Tab is not active; screenshot unavailable. Use read_page instead." };
          }
          try {
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
              format: "jpeg",
              quality: 30,
            });
            // `image` is lifted out into an inlineData part by the caller.
            return {
              ok: true,
              note: "Screenshot of the current page is attached below.",
              image: { mimeType: "image/jpeg", data: String(dataUrl).split(",")[1] },
            };
          } catch (e) {
            return { error: "Screenshot failed: " + (e?.message || e) };
          }
        }

        case "read_console": {
          if (typeof Eyes === "undefined" || !Eyes.isAttached(tabId)) {
            return {
              error: "Console is not attached. The user must enable the 👁️ button in the panel.",
            };
          }
          return { ok: true, data: Eyes.debugText() || "(empty for now)" };
        }

        case "run_js": {
          const code = String(args?.code || "");
          if (typeof Eyes === "undefined" || !Eyes.isAttached(tabId)) {
            return { error: "Enable the 👁️ button to run JS (it requires the debugger)." };
          }
          const r = await Eyes.evaluate(code);
          if (r.error) return { error: r.error };
          await new Promise((rsv) => setTimeout(rsv, 400)); // let DOM settle
          return { result: r.value ?? null };
        }

        default:
          return { error: "Unknown tool: " + name };
      }
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }

  // Short human label for the status line.
  function label(name, args) {
    switch (name) {
      case "read_page": return "читаю сторінку…";
      case "dom_map": return "мапа елементів…";
      case "navigate": return "переходжу: " + (args?.url || "");
      case "click": return "клік: " + (args?.text || "");
      case "type": return `ввід «${args?.text || ""}»` + (args?.into ? ` → ${args.into}` : "");
      case "look": return "дивлюсь (скриншот)";
      case "read_console": return "читаю консоль";
      case "run_js": return "JS: " + String(args?.code || "").slice(0, 60);
      default: return name;
    }
  }

  return { declarations, exec, bind, label };
})();
