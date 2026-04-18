// Clay Chrome Extension - Content Script
// Injected into Clay tabs. Bridges background.js <-> Clay page.
// Uses a long-lived port connection for reliable bidirectional messaging.
// Auto-reconnects when the MV3 service worker sleeps and the port drops.

var port = null;
var reconnectTimer = null;

function connectPort() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try {
    port = chrome.runtime.connect({ name: "clay-tab" });
    console.log("[clay-ext] port connected");
  } catch (e) {
    console.log("[clay-ext] port connect failed:", e.message);
    port = null;
    scheduleReconnect();
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
    var err = chrome.runtime.lastError;
    console.log("[clay-ext] port disconnected", err ? err.message : "");
    port = null;
    // Notify Clay page that extension disconnected
    window.postMessage(
      {
        source: "clay-chrome-extension",
        payload: { type: "clay_ext_disconnected" },
      },
      "*"
    );
    // Auto-reconnect after brief delay (service worker may need to wake up)
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    if (!port) {
      console.log("[clay-ext] attempting reconnect...");
      connectPort();
    }
  }, 1000);
}

function ensurePort() {
  if (port) return true;
  connectPort();
  return !!port;
}

connectPort();

// Relay messages from Clay page to background.js
window.addEventListener("message", function (event) {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "clay-page") return;

  if (ensurePort()) {
    try {
      port.postMessage(event.data.payload);
    } catch (e) {
      // Port broke mid-send, reconnect and retry once
      port = null;
      connectPort();
      if (port) {
        try { port.postMessage(event.data.payload); } catch (e2) {}
      }
    }
  }
});
