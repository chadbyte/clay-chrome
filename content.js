// Clay Chrome Extension - Content Script
// Injected into Clay tabs. Bridges background.js <-> Clay page.

// Register with background service worker
chrome.runtime.sendMessage({ type: "clay_ext_register" });

// Unregister on page unload
window.addEventListener("beforeunload", function () {
  chrome.runtime.sendMessage({ type: "clay_ext_unregister" });
});

// Relay messages from background.js to Clay page
chrome.runtime.onMessage.addListener(function (msg) {
  if (msg.type === "clay_ext_tab_list" || msg.type === "clay_ext_result") {
    window.postMessage(
      {
        source: "clay-chrome-extension",
        payload: msg,
      },
      "*"
    );
  }
});

// Relay messages from Clay page to background.js
window.addEventListener("message", function (event) {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "clay-page") return;

  chrome.runtime.sendMessage(event.data.payload);
});
