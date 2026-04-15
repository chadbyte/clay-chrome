// Clay Chrome Extension - Background Service Worker
// Tracks open tabs and relays commands between Clay page and browser
// Bridges local MCP servers to Clay via Native Messaging

// --- State ---
var clayTabIds = new Set();
var injectedTabs = new Set();
var allTabs = [];

// --- MCP State ---
var mcpNativePort = null;
var mcpServers = [];           // parsed from config: [{ name, transport, command, args, env, url }]
var mcpServerToggles = {};     // { serverName: true/false }
var mcpHostConnected = false;
var mcpPendingCallbacks = {};  // callId -> callback
var mcpCallCounter = 0;

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

// Clay tab URL patterns (must match manifest content_scripts.matches)
var CLAY_URL_PATTERNS = [
  /^https?:\/\/[^/]*\.clay\.studio\//,
  /^https?:\/\/localhost(:\d+)?\//,
  /^https?:\/\/127\.0\.0\.1(:\d+)?\//
];

function isClayUrl(url) {
  if (!url) return false;
  for (var i = 0; i < CLAY_URL_PATTERNS.length; i++) {
    if (CLAY_URL_PATTERNS[i].test(url)) return true;
  }
  return false;
}

function isClayTab(tab) {
  return isClayUrl(tab.url);
}

function broadcastTabList() {
  chrome.tabs.query({}, function (tabs) {
    allTabs = [];

    for (var i = 0; i < tabs.length; i++) {
      if (!isClayTab(tabs[i])) {
        allTabs.push({
          id: tabs[i].id,
          url: tabs[i].url || "",
          title: tabs[i].title || "",
          favIconUrl: tabs[i].favIconUrl || "",
        });
      }
    }

    var msg = { type: "clay_ext_tab_list", tabs: allTabs, extensionId: chrome.runtime.id };
    var portIds = Object.keys(clayPorts);
    for (var j = 0; j < portIds.length; j++) {
      try {
        clayPorts[portIds[j]].postMessage(msg);
      } catch (e) {
        delete clayPorts[portIds[j]];
      }
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
  tab_wait_navigation: waitForNavigation,
};

// --- Clay Tab Ports (long-lived connections from content scripts) ---

var clayPorts = {}; // tabId -> port

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== "clay-tab") return;

  var tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (!tabId) return;

  clayPorts[tabId] = port;
  clayTabIds.add(tabId);
  broadcastTabList();
  broadcastMcpServers();

  port.onMessage.addListener(function (msg) {
    // Command from Clay page (relayed by content script)
    if (msg.type === "clay_ext_command") {
      var handler = COMMANDS[msg.command];
      if (handler) {
        handler(msg.args, function (result) {
          try {
            port.postMessage({
              type: "clay_ext_result",
              requestId: msg.requestId,
              result: result,
            });
          } catch (e) {
            // Port disconnected
          }
        });
      }
    }

    // MCP tool call from Clay page
    if (msg.type === "mcp_tool_call") {
      mcpRelayToolCall(msg, tabId);
    }

    // MCP tool list request from Clay page
    if (msg.type === "mcp_tools_list") {
      mcpRelayToolsList(msg, tabId);
    }
  });

  port.onDisconnect.addListener(function () {
    void chrome.runtime.lastError;
    delete clayPorts[tabId];
    clayTabIds.delete(tabId);
  });
});

// --- Popup Message Handling (still uses one-off messages) ---

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!sender.tab) {
    if (msg.type === "mcp_check_host") {
      mcpCheckHost(sendResponse);
      return true;
    }

    // Server CRUD: relay to native host
    if (msg.type === "mcp_add_server") {
      mcpSendNative({
        type: "add_server",
        name: msg.name,
        command: msg.command,
        args: msg.args,
        env: msg.env
      }, function (response) {
        sendResponse(response);
        broadcastMcpServers();
      });
      return true;
    }
    if (msg.type === "mcp_remove_server") {
      mcpSendNative({
        type: "remove_server",
        name: msg.name
      }, function (response) {
        sendResponse(response);
        broadcastMcpServers();
      });
      return true;
    }
    if (msg.type === "mcp_get_servers") {
      mcpSendNative({ type: "get_servers" }, sendResponse);
      return true;
    }

    // Import external config
    if (msg.type === "mcp_import_config") {
      mcpSendNative({
        type: "import_config",
        path: msg.path
      }, sendResponse);
      return true;
    }
    if (msg.type === "mcp_get_imports") {
      mcpSendNative({ type: "get_imports" }, sendResponse);
      return true;
    }
    if (msg.type === "mcp_remove_import") {
      mcpSendNative({
        type: "remove_import",
        path: msg.path
      }, function (response) {
        sendResponse(response);
        broadcastMcpServers();
      });
      return true;
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

function waitForNavigation(args, callback) {
  var tabId = args.tabId;
  var timeout = args.timeout || 10000;
  var done = false;
  function finish(result) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(listener);
    callback(result);
  }
  var timer = setTimeout(function () {
    finish({ error: "Navigation timeout after " + timeout + "ms" });
  }, timeout);
  function listener(updatedTabId, changeInfo, tab) {
    if (updatedTabId !== tabId) return;
    if (changeInfo.status === "complete") {
      finish({ success: true, url: tab.url || "" });
    }
  }
  chrome.tabs.onUpdated.addListener(listener);
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

// ============================================================
// MCP Bridge - Native Messaging
// ============================================================

// --- Native Host Connection ---

function mcpConnectNativeHost() {
  if (mcpNativePort) return;

  mcpNativePort = chrome.runtime.connectNative("com.clay.mcp_bridge");

  mcpNativePort.onMessage.addListener(function (msg) {
    mcpHandleNativeMessage(msg);
  });

  mcpNativePort.onDisconnect.addListener(function () {
    // Read lastError to suppress "Unchecked runtime.lastError"
    void chrome.runtime.lastError;

    mcpHostConnected = false;
    mcpNativePort = null;

    // Fail all pending callbacks
    var ids = Object.keys(mcpPendingCallbacks);
    for (var i = 0; i < ids.length; i++) {
      var cb = mcpPendingCallbacks[ids[i]];
      if (cb) cb({ error: "Native host disconnected" });
    }
    mcpPendingCallbacks = {};

    // Notify Clay tabs that MCP is unavailable
    broadcastMcpServers();
  });

  // If onDisconnect fires synchronously (host not found), port is already null
  if (mcpNativePort) {
    mcpHostConnected = true;
  }
}

function mcpDisconnectNativeHost() {
  if (mcpNativePort) {
    mcpNativePort.disconnect();
    mcpNativePort = null;
    mcpHostConnected = false;
  }
}

function mcpSendNative(msg, callback) {
  if (!mcpNativePort) {
    mcpConnectNativeHost();
  }
  if (!mcpNativePort) {
    if (callback) callback({ error: "Native host not available. Install com.clay.mcp_bridge." });
    return;
  }

  var callId = "mcp_" + (++mcpCallCounter);
  msg.callId = callId;

  if (callback) {
    mcpPendingCallbacks[callId] = callback;
    // Timeout after 30 seconds
    setTimeout(function () {
      if (mcpPendingCallbacks[callId]) {
        mcpPendingCallbacks[callId]({ error: "Timeout waiting for native host response" });
        delete mcpPendingCallbacks[callId];
      }
    }, 30000);
  }

  mcpNativePort.postMessage(msg);
}

// --- Handle messages from native host ---

function mcpHandleNativeMessage(msg) {
  // Response to a pending call
  if (msg.callId && mcpPendingCallbacks[msg.callId]) {
    var callback = mcpPendingCallbacks[msg.callId];
    delete mcpPendingCallbacks[msg.callId];
    callback(msg);
    return;
  }

  // Unsolicited messages from native host
  if (msg.type === "config_changed") {
    // Config file changed on disk, re-parse
    mcpServers = parseServerList(msg.servers || {});
    chrome.storage.local.set({ mcpServers: mcpServers });
    broadcastMcpServers();
    return;
  }

  if (msg.type === "server_status") {
    broadcastMcpServers();
    return;
  }

  if (msg.type === "server_ready") {
    // A server finished MCP handshake and is ready with tools
    broadcastMcpServers();
    return;
  }
}

// --- Load config file via native host ---

function mcpLoadConfig(path, sendResponse) {
  mcpSendNative({
    type: "read_config",
    path: path
  }, function (response) {
    if (response.error) {
      sendResponse({ error: response.error });
      return;
    }

    mcpServers = parseServerList(response.servers || {});
    chrome.storage.local.set({ mcpServers: mcpServers });

    // Start watching the config file
    mcpSendNative({ type: "watch_config", path: path });

    sendResponse({ servers: mcpServers });
    broadcastMcpServers();
  });
}

// --- Parse mcpServers object from config into flat list ---

function parseServerList(serversObj) {
  var list = [];
  var names = Object.keys(serversObj);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var cfg = serversObj[name];
    var entry = { name: name };

    if (cfg.url) {
      entry.transport = "http";
      entry.url = cfg.url;
    } else {
      entry.transport = "stdio";
      entry.command = cfg.command || "";
      entry.args = cfg.args || [];
      entry.env = cfg.env || {};
    }

    list.push(entry);
  }
  return list;
}

// --- Toggle server on/off ---

function mcpHandleToggle(serverName, enabled) {
  mcpServerToggles[serverName] = enabled;
  chrome.storage.local.set({ mcpServerToggles: mcpServerToggles });

  if (enabled) {
    // Tell native host to spawn the server
    var server = mcpServers.find(function (s) { return s.name === serverName; });
    if (server && server.transport === "stdio") {
      mcpSendNative({
        type: "spawn_server",
        server: serverName,
        command: server.command,
        args: server.args,
        env: server.env
      });
    }
  } else {
    // Tell native host to kill the server
    mcpSendNative({
      type: "kill_server",
      server: serverName
    });
  }

  broadcastMcpServers();
}

// --- Check native host connectivity ---

function mcpCheckHost(sendResponse) {
  if (mcpHostConnected && mcpNativePort) {
    // Already connected, ping to verify
    mcpSendNative({ type: "ping" }, function (response) {
      if (response && response.type === "pong") {
        sendResponse({ connected: true });
      } else {
        sendResponse({ connected: false, error: response.error || "Unexpected response" });
      }
    });
    return;
  }

  // Try to connect, then wait briefly for disconnect event
  mcpConnectNativeHost();

  // Give onDisconnect a tick to fire if host is missing
  setTimeout(function () {
    if (mcpHostConnected && mcpNativePort) {
      mcpSendNative({ type: "ping" }, function (response) {
        if (response && response.type === "pong") {
          sendResponse({ connected: true });
        } else {
          sendResponse({ connected: false, error: response.error || "Unexpected response" });
        }
      });
    } else {
      sendResponse({ connected: false, error: "Native host not found. Install com.clay.mcp_bridge." });
    }
  }, 100);
}

// --- Relay MCP tool call from Clay page to native host ---

function mcpRelayToolCall(msg, clayTabId) {
  var serverName = msg.server;

  // Check if server is a local HTTP server (handle directly from webapp)
  var server = mcpServers.find(function (s) { return s.name === serverName; });
  if (!server) {
    sendToClayTab(clayTabId, {
      type: "mcp_tool_result",
      callId: msg.callId,
      error: "Unknown MCP server: " + serverName
    });
    return;
  }

  // HTTP servers are called directly from webapp, shouldn't reach here
  // But handle gracefully if they do
  if (server.transport === "http") {
    sendToClayTab(clayTabId, {
      type: "mcp_tool_result",
      callId: msg.callId,
      error: "HTTP MCP servers should be called directly from webapp via fetch"
    });
    return;
  }

  // stdio server: relay through native host
  mcpSendNative({
    type: "mcp_request",
    server: serverName,
    method: msg.method,
    params: msg.params
  }, function (response) {
    sendToClayTab(clayTabId, {
      type: "mcp_tool_result",
      callId: msg.callId,
      result: response.result || null,
      error: response.error || null
    });
  });
}

// --- Relay MCP tools/list request ---

function mcpRelayToolsList(msg, clayTabId) {
  var serverName = msg.server;

  mcpSendNative({
    type: "mcp_request",
    server: serverName,
    method: "tools/list",
    params: {}
  }, function (response) {
    sendToClayTab(clayTabId, {
      type: "mcp_tools_list_result",
      callId: msg.callId,
      server: serverName,
      result: response.result || null,
      error: response.error || null
    });
  });
}

// --- Broadcast MCP server list to all Clay tabs ---

function broadcastMcpServers() {
  if (!mcpHostConnected || !mcpNativePort) {
    broadcastToClayTabs({
      type: "mcp_servers_available",
      servers: [],
      hostConnected: false
    });
    return;
  }

  // Fetch live server list from native host
  mcpSendNative({ type: "get_servers" }, function (response) {
    var servers = (response && response.servers) || [];
    var serverList = servers.map(function (s) {
      return {
        name: s.name,
        transport: s.transport,
        tools: s.tools || [],
        enabled: true,
        running: s.running
      };
    });

    broadcastToClayTabs({
      type: "mcp_servers_available",
      servers: serverList,
      hostConnected: true
    });
  });
}

// --- Utility: send message to a specific Clay tab ---

function sendToClayTab(tabId, msg) {
  var p = clayPorts[tabId];
  if (p) {
    try { p.postMessage(msg); } catch (e) { delete clayPorts[tabId]; }
  }
}

// --- Utility: broadcast to all Clay tabs ---

function broadcastToClayTabs(msg) {
  var portIds = Object.keys(clayPorts);
  for (var i = 0; i < portIds.length; i++) {
    try {
      clayPorts[portIds[i]].postMessage(msg);
    } catch (e) {
      delete clayPorts[portIds[i]];
    }
  }
}

// --- Restore saved toggles on startup ---

chrome.storage.local.get(["mcpServers", "mcpServerToggles"], function (data) {
  if (data.mcpServers) {
    mcpServers = data.mcpServers;
  }
  if (data.mcpServerToggles) {
    mcpServerToggles = data.mcpServerToggles;
  }
});
