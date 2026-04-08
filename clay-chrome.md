# Clay Chrome Extension Plan

> Goal: Connect the user's local browser to a remote Clay server. The extension gives Claude eyes into the browser: open tabs, console logs, network requests, DOM, screenshots. Zero config. Install and it works.

---

## Architecture

```
[Chrome Extension]                          [Clay Web Page]                    [Clay Server]
                                            (already open in browser)
background.js                               app.js
  |                                           |                                  |
  |-- chrome.tabs API (tab list)              |                                  |
  |-- chrome.debugger API (devtools)          |                                  |
  |                                           |                                  |
  +---> content.js (injected into Clay tab)   |                                  |
           |                                  |                                  |
           +--- window.postMessage ---------> |                                  |
                                              +--- WebSocket -----------------> |
                                                                                 |
                                              <--- WebSocket (commands) -------- +
           <--- window.postMessage ---------- |
  <------- message from content.js            |
  |
  +-- execute command (screenshot, console, etc.)
  |
  +---> content.js --- postMessage ---> app.js --- WebSocket ---> server
```

### Key Insight
The extension never talks to the Clay server directly. It communicates through the Clay web page that is already open in the browser. The Clay page already has a WebSocket connection to the server. The extension piggybacks on that.

### Communication Flow
1. **Extension to Clay**: `background.js` sends message to `content.js` via `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`. Content script relays to Clay page via `window.postMessage`.
2. **Clay to Extension**: Clay page posts message via `window.postMessage`. Content script picks it up and relays to `background.js` via `chrome.runtime.sendMessage`.
3. **Clay to Server**: Normal WebSocket, already exists.

---

## Files

```
clay-chrome/
├── manifest.json          # Extension manifest (Manifest V3)
├── background.js          # Service worker: tab tracking, chrome.debugger, command dispatch
├── content.js             # Injected into Clay tabs: bridge between extension and Clay page
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── PLAN.md
```

No popup. No options page. No UI at all in the extension itself. All UI lives in Clay.

---

## manifest.json

```json
{
  "manifest_version": 3,
  "name": "Clay",
  "version": "0.1.0",
  "description": "Connect your browser to Clay.",
  "permissions": [
    "tabs",
    "activeTab",
    "debugger",
    "scripting"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["*://*.clay.studio/*", "*://localhost:*/*", "*://127.0.0.1:*/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

### Content script matching
- `*.clay.studio` covers all clay-dns domains (e.g. `192-168-1-50.d.clay.studio`)
- `localhost` and `127.0.0.1` for local dev
- If users self-host on custom domains, they can add permissions manually (future: options page)

---

## background.js (Service Worker)

### Responsibilities
1. Track all open tabs (listen to `chrome.tabs.onCreated`, `onRemoved`, `onUpdated`)
2. Broadcast tab list to Clay page whenever tabs change
3. Receive commands from Clay page (via content script relay)
4. Execute commands using `chrome.debugger` API
5. Send results back to Clay page

### Tab Tracking

```js
// State
var clayTabIds = new Set();  // tabs that have Clay open (content script registered)
var allTabs = [];             // current tab list for Clay UI

// Events
chrome.tabs.onCreated.addListener(broadcastTabList);
chrome.tabs.onRemoved.addListener(broadcastTabList);
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo) {
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    broadcastTabList();
  }
});

function broadcastTabList() {
  chrome.tabs.query({}, function(tabs) {
    allTabs = tabs
      .filter(function(t) { return !isClayTab(t); })  // exclude Clay tabs themselves
      .map(function(t) {
        return {
          id: t.id,
          url: t.url || "",
          title: t.title || "",
          favIconUrl: t.favIconUrl || ""
        };
      });

    // Send to all Clay tabs
    for (var clayTabId of clayTabIds) {
      chrome.tabs.sendMessage(clayTabId, {
        type: "clay_ext_tab_list",
        tabs: allTabs
      });
    }
  });
}
```

### Command Execution

Commands come from Clay server via: server -> websocket -> app.js -> postMessage -> content.js -> background.js

```js
// Commands the extension can execute
var COMMANDS = {
  // Tab management
  "tab_open":        openTab,          // Open a URL in new tab
  "tab_close":       closeTab,         // Close a tab
  "tab_activate":    activateTab,      // Switch to a tab

  // Debugging (requires chrome.debugger attach)
  "tab_screenshot":  takeScreenshot,   // Capture visible area
  "tab_console":     getConsoleLogs,   // Get console messages
  "tab_network":     getNetworkLog,    // Get network requests
  "tab_dom":         getDOM,           // Get page HTML/text
  "tab_evaluate":    evaluateScript,   // Run JS in page context
  "tab_navigate":    navigateTo,       // Navigate tab to URL
};

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
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
      handler(msg.args, function(result) {
        // Send result back to the Clay tab that requested it
        chrome.tabs.sendMessage(sender.tab.id, {
          type: "clay_ext_result",
          requestId: msg.requestId,
          result: result
        });
      });
    }
  }
});
```

### chrome.debugger Usage

The debugger API requires attaching to a tab first. Attach on demand, detach after command.

```js
function takeScreenshot(args, callback) {
  var tabId = args.tabId;
  chrome.debugger.attach({ tabId: tabId }, "1.3", function() {
    chrome.debugger.sendCommand(
      { tabId: tabId },
      "Page.captureScreenshot",
      { format: "png", quality: 80 },
      function(result) {
        chrome.debugger.detach({ tabId: tabId });
        callback({ image: result.data });  // base64 PNG
      }
    );
  });
}

function getConsoleLogs(args, callback) {
  var tabId = args.tabId;
  var logs = [];
  chrome.debugger.attach({ tabId: tabId }, "1.3", function() {
    chrome.debugger.sendCommand({ tabId: tabId }, "Console.enable", {});
    chrome.debugger.onEvent.addListener(function listener(source, method, params) {
      if (source.tabId !== tabId) return;
      if (method === "Console.messageAdded") {
        logs.push(params.message);
      }
    });
    // Collect for a short period then return
    // Or: use Runtime.evaluate to get existing console history
    chrome.debugger.sendCommand(
      { tabId: tabId },
      "Runtime.evaluate",
      { expression: "JSON.stringify(window.__clay_console_buffer || [])" },
      function(result) {
        chrome.debugger.detach({ tabId: tabId });
        callback({ logs: logs, buffered: result.result.value });
      }
    );
  });
}

function getNetworkLog(args, callback) {
  // Similar pattern: attach, Network.enable, collect, detach
}

function evaluateScript(args, callback) {
  var tabId = args.tabId;
  chrome.debugger.attach({ tabId: tabId }, "1.3", function() {
    chrome.debugger.sendCommand(
      { tabId: tabId },
      "Runtime.evaluate",
      { expression: args.script, returnByValue: true },
      function(result) {
        chrome.debugger.detach({ tabId: tabId });
        callback({ value: result.result.value });
      }
    );
  });
}

function getDOM(args, callback) {
  var tabId = args.tabId;
  chrome.debugger.attach({ tabId: tabId }, "1.3", function() {
    chrome.debugger.sendCommand(
      { tabId: tabId },
      "Runtime.evaluate",
      {
        expression: "document.documentElement.outerHTML",
        returnByValue: true
      },
      function(result) {
        chrome.debugger.detach({ tabId: tabId });
        // Return text content, strip HTML for Claude
        callback({ html: result.result.value });
      }
    );
  });
}
```

### Note on chrome.debugger UX
When `chrome.debugger.attach` is called, Chrome shows an info bar: "Clay started debugging this tab". This is a Chrome security requirement and cannot be suppressed. Users will see this once per tab when Clay inspects it. Consider keeping debugger attached for active context source tabs to avoid repeated attach/detach.

---

## content.js (Content Script)

Injected into Clay tabs. Bridges between background.js and Clay page.

```js
// Register with background
chrome.runtime.sendMessage({ type: "clay_ext_register" });

// Unregister on page unload
window.addEventListener("beforeunload", function() {
  chrome.runtime.sendMessage({ type: "clay_ext_unregister" });
});

// Relay messages from background.js to Clay page
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === "clay_ext_tab_list" || msg.type === "clay_ext_result") {
    window.postMessage({
      source: "clay-chrome-extension",
      payload: msg
    }, "*");
  }
});

// Relay messages from Clay page to background.js
window.addEventListener("message", function(event) {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "clay-page") return;

  chrome.runtime.sendMessage(event.data.payload);
});
```

Simple relay. No logic. Just bridges two messaging systems.

---

## Clay Page Integration (app.js changes)

### Extension Detection

```js
// Listen for extension messages
window.addEventListener("message", function(event) {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "clay-chrome-extension") return;

  var msg = event.data.payload;

  if (msg.type === "clay_ext_tab_list") {
    // Update Context Sources UI with browser tabs
    updateBrowserTabList(msg.tabs);
  }

  if (msg.type === "clay_ext_result") {
    // Handle command result (screenshot, console, etc.)
    handleExtensionResult(msg.requestId, msg.result);
  }
});
```

### Extension presence
If the extension is installed, Clay will receive `clay_ext_tab_list` messages. If not installed, no messages arrive and the UI simply does not show browser tabs in Context Sources. Zero config.

### Sending Commands to Extension

```js
function sendExtensionCommand(command, args) {
  var requestId = crypto.randomUUID();
  window.postMessage({
    source: "clay-page",
    payload: {
      type: "clay_ext_command",
      command: command,
      args: args,
      requestId: requestId
    }
  }, "*");
  return requestId;
}

// Examples:
// sendExtensionCommand("tab_screenshot", { tabId: 123 });
// sendExtensionCommand("tab_console", { tabId: 123 });
// sendExtensionCommand("tab_evaluate", { tabId: 123, script: "document.title" });
// sendExtensionCommand("tab_open", { url: "https://example.com" });
```

---

## Context Sources UI Changes

### Browser tab list in picker

When extension sends tab list, add a "Browser Tabs" section to the context sources picker:

```
TERMINALS
  Terminal 1: bash           [check]

BROWSER TABS                          <-- new section
  localhost:3000 - My App    [check]
  github.com/chadbyte/clay   [ ]
  stackoverflow.com/...      [ ]
```

### Tab as context source

When a browser tab is selected as context source, on each message:
1. Send `tab_console` command to get console logs
2. Send `tab_network` command to get recent network requests (optional)
3. Inject results into Claude message, same as terminal context

Format:
```
[Browser tab: localhost:3000 - My App]
Console:
  [ERROR] Uncaught TypeError: Cannot read property 'map' of undefined (app.js:42)
  [WARN] React does not recognize the `isActive` prop (Button.jsx:15)

Network (last 10 requests):
  GET /api/users 200 12ms
  POST /api/login 401 45ms "Invalid credentials"
```

---

## Server-Side Changes (lib/project.js)

### New message types

```js
// Client -> Server: extension detected
{ type: "extension_connected" }

// Client -> Server: browser tab list update
{ type: "browser_tab_list", tabs: [{ id, url, title, favIconUrl }] }

// Client -> Server: save context sources (already exists, tabs use "tab:{id}" prefix)
{ type: "context_sources_save", active: ["term:1", "tab:12345"] }

// Server -> Client: request tab data (when user sends message with tab context source)
{ type: "extension_command", command: "tab_console", args: { tabId: 123 }, requestId: "uuid" }

// Client -> Server: tab data result
{ type: "extension_result", requestId: "uuid", result: { logs: [...] } }
```

### Context injection flow

When user sends a message and has browser tabs as context sources:

1. Server sees `tab:123` in active sources
2. Server sends `{ type: "extension_command", command: "tab_console", args: { tabId: 123 } }` to client
3. Client relays to extension via postMessage
4. Extension executes `chrome.debugger` command
5. Extension sends result back through content.js -> app.js -> WebSocket
6. Server receives result, injects into Claude message

**Problem**: This is async. The message send flow needs to wait for extension results before sending to Claude.

**Solution**: When active sources include browser tabs, the server:
1. Sends command requests to client
2. Waits up to 3 seconds for results
3. Injects whatever came back into the message
4. If timeout, sends message without tab context and notes "Browser tab context unavailable"

---

## Implementation Phases

### Phase 1: Tab awareness (MVP)
Files: `manifest.json`, `background.js`, `content.js`
Clay changes: `context-sources.js`, `app.js`

- Extension detects Clay tab, registers
- Tab list broadcast on tab open/close/update
- Context Sources UI shows browser tabs
- Tabs selectable as context sources
- No debugger commands yet, just awareness

**Deliverable**: User installs extension, sees their open tabs in Context Sources picker.

### Phase 2: Console and DOM reading
- `tab_console`: Read console logs from selected tabs
- `tab_dom`: Read page text content
- `tab_evaluate`: Run arbitrary JS
- Inject console/DOM into Claude messages when tab is context source

**Deliverable**: Claude can see console errors from the user's localhost.

### Phase 3: Network and screenshots
- `tab_network`: Capture network request/response log
- `tab_screenshot`: Capture visible area as base64 PNG
- Screenshot displayed in Clay chat as image

**Deliverable**: Claude can see what the page looks like and what API calls are happening.

### Phase 4: Active browser control
- `tab_open`: Open new tabs
- `tab_navigate`: Navigate existing tabs
- `tab_close`: Close tabs
- Claude can autonomously browse, inspect, and debug

**Deliverable**: "Open localhost:3000 and check if the login page works" just works.

---

## Security Considerations

1. **Content script matching**: Only injected into Clay domains. Extension cannot leak data to non-Clay pages.
2. **chrome.debugger consent**: Chrome shows info bar when debugging starts. User is always aware.
3. **Tab filtering**: Clay tabs are excluded from the tab list. Extension does not expose its own debugging surface.
4. **No remote code execution**: Extension only executes commands that originate from the Clay server, which the user is already authenticated to.
5. **postMessage origin**: Content script should verify `event.origin` matches the Clay tab URL before relaying messages.

---

## Open Questions

1. **Persistent debugger attach vs on-demand?**
   On-demand is safer (less Chrome warnings) but slower. Persistent gives real-time console streaming but shows "debugging" banner permanently. Recommendation: on-demand for Phase 2, option for persistent in Phase 3.

2. **Tab favicon in Context Sources UI?**
   Extension sends `favIconUrl`. Clay can display it next to tab name in the picker. Nice to have for Phase 1.

3. **Multiple Clay tabs open?**
   Extension sends tab list to all Clay tabs. Each Clay tab manages its own context sources independently. No conflict.

4. **Extension update mechanism?**
   Chrome Web Store auto-updates. For development, load unpacked and reload manually.

