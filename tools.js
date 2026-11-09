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
    {
      name: "type",
      description:
        "Ввести текст у поле вводу (пошук, фільтр) і повернути оновлену сторінку разом із підказками автозаповнення, що з'явилися. Спершу за потреби клікни, щоб відкрити потрібне поле/фільтр.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Текст для введення" },
          into: {
            type: "string",
            description: "Частина label/placeholder поля; лишити порожнім — активне або перше видиме поле",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "look",
      description:
        "Зробити скриншот поточної сторінки і ПОБАЧИТИ її візуально. Використовуй, коли сайт — SPA і потрібних елементів немає в тексті/controls: напр. після click по фільтру, щоб побачити опції у випадаючому списку, і далі клікнути потрібну за текстом.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "read_console",
      description:
        "Прочитати консоль і мережеві запити вкладки (помилки JS, виклики API). Працює лише коли увімкнено режим очей (кнопка 👁️).",
      parameters: { type: "object", properties: {} },
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
          if (!r.typed) return { typed: false, error: "Поле вводу не знайдено" };
          await new Promise((rsv) => setTimeout(rsv, 800)); // let suggestions load
          return { typed: true, field: r.field, page: await snapshot(tabId) };
        }

        case "look": {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (!tab) return { error: "Вкладка недоступна" };
          if (!tab.active) {
            return { error: "Вкладка не активна — скриншот недоступний. Використай read_page." };
          }
          try {
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
              format: "jpeg",
              quality: 30,
            });
            // `image` is lifted out into an inlineData part by the caller.
            return {
              ok: true,
              note: "Скриншот поточної сторінки додано нижче.",
              image: { mimeType: "image/jpeg", data: String(dataUrl).split(",")[1] },
            };
          } catch (e) {
            return { error: "Скриншот не вдався: " + (e?.message || e) };
          }
        }

        case "read_console": {
          if (typeof Eyes === "undefined" || !Eyes.isAttached(tabId)) {
            return {
              error: "Консоль не під'єднана. Користувач має увімкнути кнопку 👁️ у панелі.",
            };
          }
          return { ok: true, data: Eyes.debugText() || "(поки порожньо)" };
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
      case "type": return `ввід «${args?.text || ""}»` + (args?.into ? ` → ${args.into}` : "");
      case "look": return "дивлюсь (скриншот)";
      case "read_console": return "читаю консоль";
      default: return name;
    }
  }

  return { declarations, exec, bind, label };
})();
