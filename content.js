// Clay Chrome Extension - Content Script
// Injected into Clay tabs. Bridges background.js <-> Clay page.

// --- Safe message sender (survives extension reload) ---

function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg);
  } catch (e) {
    // Extension context invalidated (extension was reloaded).
    // Notify Clay page so it knows the extension is disconnected.
    window.postMessage(
      {
        source: "clay-chrome-extension",
        payload: { type: "clay_ext_disconnected" },
      },
      "*"
    );
  }
}

// Register with background service worker
safeSend({ type: "clay_ext_register" });

// Unregister on page unload
window.addEventListener("beforeunload", function () {
  safeSend({ type: "clay_ext_unregister" });
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

  // MCP messages from background -> Clay page
  if (msg.type === "clay_ext_mcp") {
    window.postMessage(
      {
        source: "clay-chrome-extension",
        payload: msg.payload,
      },
      "*"
    );
  }
});

// Relay messages from Clay page to background.js
window.addEventListener("message", function (event) {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "clay-page") return;

  var payload = event.data.payload;
  safeSend(payload);
});
