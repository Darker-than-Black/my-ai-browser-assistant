// Per-tab side panel: the assistant is bound to the tab it was opened on,
// instead of showing across every tab in the window.
const PANEL_PATH = "sidepanel.html";

chrome.runtime.onInstalled.addListener(disableEverywhere);
chrome.runtime.onStartup.addListener(disableEverywhere);

// Hide the panel by default on all tabs; it is enabled per-tab on action click.
async function disableEverywhere() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    await chrome.sidePanel.setOptions({ enabled: false });
  } catch (error) {
    console.error("Side Panel init error:", error);
  }
}

// Open the panel only on the clicked tab, and remember which tab that is so the
// panel can scope its work to it (via chrome.storage).
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  // open() must be called synchronously within the click gesture — no await
  // before it, or Chrome rejects it ("may only be called in response to a
  // user gesture"). setOptions and storage can settle in the background.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch((error) =>
    console.error("Side Panel open error:", error)
  );
  chrome.storage.session.set({ boundTabId: tab.id, boundWindowId: tab.windowId });
});

// When the bound tab closes, drop the stored binding.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const { boundTabId } = await chrome.storage.session.get("boundTabId");
    if (boundTabId === tabId) await chrome.storage.session.remove(["boundTabId", "boundWindowId"]);
  } catch (_) {}
});
