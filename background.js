// Open the side panel when the toolbar icon is clicked, on any tab.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Side Panel init error:", error));
