// Clay Chrome Extension - Content Script
// Injected into Clay tabs. Bridges background.js <-> Clay page.
// Uses a long-lived port connection for reliable bidirectional messaging.

var port = null;

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: "clay-tab" });
  } catch (e) {
    return;
  }

  // Messages from background -> Clay page
  port.onMessage.addListener(function (msg) {
    window.postMessage(
      {
        source: "clay-chrome-extension",
        payload: msg,
      },
      "*"
    );
  });

  port.onDisconnect.addListener(function () {
    void chrome.runtime.lastError;
    port = null;
    // Notify Clay page that extension disconnected
    window.postMessage(
      {
        source: "clay-chrome-extension",
        payload: { type: "clay_ext_disconnected" },
      },
      "*"
    );
  });
}

connectPort();

// Relay messages from Clay page to background.js
window.addEventListener("message", function (event) {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "clay-page") return;

  if (port) {
    try {
      port.postMessage(event.data.payload);
    } catch (e) {
      // Port disconnected, try to reconnect
      connectPort();
      if (port) port.postMessage(event.data.payload);
    }
  }
});
