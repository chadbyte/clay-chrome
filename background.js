// Clay Chrome Extension - Background Service Worker
// Tracks open tabs and relays commands between Clay page and browser

// --- State ---
var clayTabIds = new Set();
var allTabs = [];

// --- Tab Tracking ---

chrome.tabs.onCreated.addListener(broadcastTabList);
chrome.tabs.onRemoved.addListener(function (tabId) {
  clayTabIds.delete(tabId);
  broadcastTabList();
});
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    broadcastTabList();
  }
});

function isClayTab(tab) {
  if (!tab.url) return false;
  try {
    var url = new URL(tab.url);
    if (url.hostname.endsWith(".clay.studio")) return true;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      // Only treat as Clay tab if content script registered it
      return clayTabIds.has(tab.id);
    }
  } catch (e) {
    // ignore
  }
  return false;
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

// --- Commands ---

var COMMANDS = {
  // Tab management
  tab_open: openTab,
  tab_close: closeTab,
  tab_activate: activateTab,

  // Debugging (requires chrome.debugger attach)
  tab_screenshot: takeScreenshot,
  tab_console: getConsoleLogs,
  tab_network: getNetworkLog,
  tab_dom: getDOM,
  tab_evaluate: evaluateScript,
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
    chrome.debugger.sendCommand(
      { tabId: tabId },
      "Page.captureScreenshot",
      { format: "png", quality: 80 },
      function (result) {
        detachDebugger(tabId);
        if (chrome.runtime.lastError || !result) {
          return callback({ error: (chrome.runtime.lastError || {}).message || "Screenshot failed" });
        }
        callback({ image: result.data });
      }
    );
  });
}

function getConsoleLogs(args, callback) {
  withDebugger(args.tabId, function (tabId, err) {
    if (err) return callback({ error: err });
    chrome.debugger.sendCommand(
      { tabId: tabId },
      "Runtime.evaluate",
      {
        expression: "JSON.stringify(window.__clay_console_buffer || [])",
        returnByValue: true,
      },
      function (result) {
        detachDebugger(tabId);
        if (chrome.runtime.lastError || !result) {
          return callback({ error: (chrome.runtime.lastError || {}).message || "Console read failed" });
        }
        callback({ logs: result.result.value });
      }
    );
  });
}

function getNetworkLog(args, callback) {
  withDebugger(args.tabId, function (tabId, err) {
    if (err) return callback({ error: err });
    chrome.debugger.sendCommand(
      { tabId: tabId },
      "Runtime.evaluate",
      {
        expression: "JSON.stringify(window.__clay_network_buffer || [])",
        returnByValue: true,
      },
      function (result) {
        detachDebugger(tabId);
        if (chrome.runtime.lastError || !result) {
          return callback({ error: (chrome.runtime.lastError || {}).message || "Network read failed" });
        }
        callback({ network: result.result.value });
      }
    );
  });
}

function getDOM(args, callback) {
  withDebugger(args.tabId, function (tabId, err) {
    if (err) return callback({ error: err });
    chrome.debugger.sendCommand(
      { tabId: tabId },
      "Runtime.evaluate",
      {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      },
      function (result) {
        detachDebugger(tabId);
        if (chrome.runtime.lastError || !result) {
          return callback({ error: (chrome.runtime.lastError || {}).message || "DOM read failed" });
        }
        callback({ html: result.result.value });
      }
    );
  });
}

function evaluateScript(args, callback) {
  withDebugger(args.tabId, function (tabId, err) {
    if (err) return callback({ error: err });
    chrome.debugger.sendCommand(
      { tabId: tabId },
      "Runtime.evaluate",
      {
        expression: args.script,
        returnByValue: true,
      },
      function (result) {
        detachDebugger(tabId);
        if (chrome.runtime.lastError || !result) {
          return callback({ error: (chrome.runtime.lastError || {}).message || "Eval failed" });
        }
        callback({ value: result.result.value });
      }
    );
  });
}
