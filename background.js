// Clay Chrome Extension - Background Service Worker
// Tracks open tabs and relays commands between Clay page and browser

// --- State ---
var clayTabIds = new Set();
var injectedTabs = new Set();
var allTabs = [];

// --- Tab Tracking ---

chrome.tabs.onCreated.addListener(broadcastTabList);
chrome.tabs.onRemoved.addListener(function (tabId) {
  clayTabIds.delete(tabId);
  injectedTabs.delete(tabId);
  broadcastTabList();
});
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  // Page navigated — injection is lost, need to re-inject
  if (changeInfo.status === "loading") {
    injectedTabs.delete(tabId);
  }
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    broadcastTabList();
  }
});

function isClayTab(tab) {
  // Only exclude tabs where the content script is actively registered
  // (i.e. the tab that is running Clay and bridging to this extension)
  return clayTabIds.has(tab.id);
}

function broadcastTabList() {
  chrome.tabs.query({}, function (tabs) {
    allTabs = tabs
      .filter(function (t) {
        return !isClayTab(t);
      })
      .map(function (t) {
        return {
          id: t.id,
          url: t.url || "",
          title: t.title || "",
          favIconUrl: t.favIconUrl || "",
        };
      });

    for (var clayTabId of clayTabIds) {
      chrome.tabs.sendMessage(clayTabId, {
        type: "clay_ext_tab_list",
        tabs: allTabs,
      }).catch(function () {
        // Tab may have been closed, ignore
      });
    }
  });
}

// --- Injection ---

function ensureInjected(tabId, callback) {
  if (injectedTabs.has(tabId)) {
    callback(true);
    return;
  }
  chrome.scripting.executeScript(
    {
      target: { tabId: tabId },
      files: ["inject.js"],
      world: "MAIN",
    },
    function () {
      if (chrome.runtime.lastError) {
        callback(false, chrome.runtime.lastError.message);
        return;
      }
      injectedTabs.add(tabId);
      callback(true);
    }
  );
}

// --- Commands ---

var COMMANDS = {
  // Tab management
  tab_open: openTab,
  tab_close: closeTab,
  tab_activate: activateTab,

  // Injection
  tab_inject: injectTab,

  // Page data (no debugger needed)
  tab_console: getConsoleLogs,
  tab_network: getNetworkLog,
  tab_dom: getDOM,
  tab_evaluate: evaluateScript,
  tab_page_text: getPageText,

  // Debugging (requires chrome.debugger attach)
  tab_screenshot: takeScreenshot,
  tab_navigate: navigateTo,
};

// --- Message Handling ---

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!sender.tab) return;

  // Content script registered (Clay tab found)
  if (msg.type === "clay_ext_register") {
    clayTabIds.add(sender.tab.id);
    broadcastTabList();
    return;
  }

  // Content script unregistered (Clay tab closed)
  if (msg.type === "clay_ext_unregister") {
    clayTabIds.delete(sender.tab.id);
    return;
  }

  // Command from Clay page (relayed by content script)
  if (msg.type === "clay_ext_command") {
    var handler = COMMANDS[msg.command];
    if (handler) {
      handler(msg.args, function (result) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: "clay_ext_result",
          requestId: msg.requestId,
          result: result,
        }).catch(function () {
          // Clay tab may have closed
        });
      });
    }
  }
});

// --- Tab Management Commands ---

function openTab(args, callback) {
  chrome.tabs.create({ url: args.url, active: args.active !== false }, function (tab) {
    callback({ tabId: tab.id });
  });
}

function closeTab(args, callback) {
  chrome.tabs.remove(args.tabId, function () {
    callback({ success: true });
  });
}

function activateTab(args, callback) {
  chrome.tabs.update(args.tabId, { active: true }, function () {
    callback({ success: true });
  });
}

function navigateTo(args, callback) {
  chrome.tabs.update(args.tabId, { url: args.url }, function () {
    callback({ success: true });
  });
}

// --- Injection Command ---

function injectTab(args, callback) {
  ensureInjected(args.tabId, function (ok, err) {
    if (!ok) return callback({ error: err || "Injection failed" });
    callback({ success: true });
  });
}

// --- Debugger Commands ---

function withDebugger(tabId, fn) {
  chrome.debugger.attach({ tabId: tabId }, "1.3", function () {
    if (chrome.runtime.lastError) {
      fn(null, chrome.runtime.lastError.message);
      return;
    }
    fn(tabId, null);
  });
}

function detachDebugger(tabId) {
  chrome.debugger.detach({ tabId: tabId }, function () {
    // Ignore errors on detach
    void chrome.runtime.lastError;
  });
}

function takeScreenshot(args, callback) {
  withDebugger(args.tabId, function (tabId, err) {
    if (err) return callback({ error: err });

    function captureWithClip(clip) {
      var params = { format: "png", quality: 80 };
      if (clip) params.clip = clip;
      chrome.debugger.sendCommand(
        { tabId: tabId },
        "Page.captureScreenshot",
        params,
        function (result) {
          detachDebugger(tabId);
          if (chrome.runtime.lastError || !result) {
            return callback({ error: (chrome.runtime.lastError || {}).message || "Screenshot failed" });
          }
          callback({ image: result.data });
        }
      );
    }

    if (args.selector) {
      // Get bounding box of the target element
      chrome.debugger.sendCommand(
        { tabId: tabId },
        "Runtime.evaluate",
        {
          expression: "(function() { var el = document.querySelector(" + JSON.stringify(args.selector) + "); if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()",
          returnByValue: true,
        },
        function (result) {
          if (chrome.runtime.lastError || !result || !result.result || !result.result.value) {
            // Element not found or error, fall back to full viewport
            captureWithClip(null);
            return;
          }
          var rect = result.result.value;
          captureWithClip({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 });
        }
      );
    } else {
      captureWithClip(null);
    }
  });
}

// --- Script execution (no debugger needed) ---
// Uses chrome.scripting.executeScript in MAIN world to read page-context data.
// This avoids debugger conflicts with DevTools.

function executeInPage(tabId, func, callback) {
  chrome.scripting.executeScript(
    {
      target: { tabId: tabId },
      world: "MAIN",
      func: func,
    },
    function (results) {
      if (chrome.runtime.lastError) {
        return callback({ error: chrome.runtime.lastError.message });
      }
      if (!results || !results[0]) {
        return callback({ error: "No result from script execution" });
      }
      callback(results[0].result);
    }
  );
}

function getConsoleLogs(args, callback) {
  ensureInjected(args.tabId, function () {
    executeInPage(args.tabId, function () {
      return { logs: JSON.stringify(window.__clay_console_buffer || []) };
    }, callback);
  });
}

function getNetworkLog(args, callback) {
  ensureInjected(args.tabId, function () {
    executeInPage(args.tabId, function () {
      return { network: JSON.stringify(window.__clay_network_buffer || []) };
    }, callback);
  });
}

function getDOM(args, callback) {
  executeInPage(args.tabId, function () {
    return { html: document.documentElement.outerHTML };
  }, callback);
}

function getPageText(args, callback) {
  // Direct page text extraction without eval (CSP-safe)
  executeInPage(args.tabId, function () {
    var text = document.body ? document.body.innerText : "";
    if (text.length > 32768) text = text.substring(0, 32768);
    return { text: text };
  }, callback);
}

function evaluateScript(args, callback) {
  // For arbitrary script evaluation, use a wrapper that evals the expression
  chrome.scripting.executeScript(
    {
      target: { tabId: args.tabId },
      world: "MAIN",
      func: function (script) {
        try {
          return { value: eval(script) };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [args.script],
    },
    function (results) {
      if (chrome.runtime.lastError) {
        return callback({ error: chrome.runtime.lastError.message });
      }
      if (!results || !results[0]) {
        return callback({ error: "No result from script execution" });
      }
      callback(results[0].result);
    }
  );
}
