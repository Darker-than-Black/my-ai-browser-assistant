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
        "Прочитати поточну сторінку прив'язаної вкладки: URL, заголовок, видимий текст і список посилань (текст + href). Використовуй, щоб побачити вміст і куди можна перейти.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "navigate",
      description:
        "Перейти за абсолютним URL у прив'язаній вкладці, дочекатися завантаження і повернути вміст нової сторінки.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Повний URL (https://...)" } },
        required: ["url"],
      },
    },
    {
      name: "click",
      description:
        "Клікнути перше посилання/кнопку, видимий текст якого містить задану підрядку, дочекатися завантаження і повернути новий вміст сторінки.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Видимий текст елемента (частина)" } },
        required: ["text"],
      },
    },
  ];

  // ---- Page snapshot (runs in the page) ----
  function pageSnapshotFn(linkCap, textCap) {
    const links = [...document.querySelectorAll("a[href]")]
      .map((a) => ({
        text: (a.innerText || a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
        href: a.href,
      }))
      .filter((l) => l.text && /^https?:/.test(l.href))
      .slice(0, linkCap);
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, textCap),
      links,
    };
  }

  async function snapshot(tabId) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageSnapshotFn,
      args: [LINK_CAP, TEXT_CAP],
    });
    return res?.result || { error: "Не вдалося прочитати сторінку" };
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
    if (tabId == null) return { error: "Немає прив'язаної вкладки" };
    try {
      switch (name) {
        case "read_page":
          return await snapshot(tabId);

        case "navigate": {
          const url = String(args?.url || "");
          if (!/^https?:\/\//.test(url)) return { error: "Потрібен повний URL (https://...)" };
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
          if (!r.clicked) return { clicked: false, error: `Елемент з текстом "${text}" не знайдено` };
          await waitComplete(tabId);
          return { clicked: true, clickedText: r.text, page: await snapshot(tabId) };
        }

        default:
          return { error: "Невідомий інструмент: " + name };
      }
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }

  // Short human label for the status line.
  function label(name, args) {
    switch (name) {
      case "read_page": return "читаю сторінку…";
      case "navigate": return "переходжу: " + (args?.url || "");
      case "click": return "клік: " + (args?.text || "");
      default: return name;
    }
  }

  return { declarations, exec, bind, label };
})();
