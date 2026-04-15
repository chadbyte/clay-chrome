// Clay Chrome Extension - Popup
// MCP config file management and server toggle UI

var configPathInput = document.getElementById("configPath");
var loadBtn = document.getElementById("loadBtn");
var configStatus = document.getElementById("configStatus");
var serverListEl = document.getElementById("serverList");
var hostStatusEl = document.getElementById("hostStatus");

// --- Init ---

chrome.storage.local.get(["mcpConfigPath", "mcpServers", "mcpServerToggles"], function (data) {
  if (data.mcpConfigPath) {
    configPathInput.value = data.mcpConfigPath;
  }
  if (data.mcpServers && data.mcpServers.length > 0) {
    renderServerList(data.mcpServers, data.mcpServerToggles || {});
  }
  checkNativeHost();
});

// --- Load Config ---

loadBtn.addEventListener("click", function () {
  var path = configPathInput.value.trim();
  if (!path) return;

  loadBtn.disabled = true;
  configStatus.className = "status";
  configStatus.textContent = "Loading...";

  chrome.runtime.sendMessage({
    type: "mcp_load_config",
    path: path
  }, function (response) {
    loadBtn.disabled = false;

    if (chrome.runtime.lastError) {
      configStatus.className = "status error";
      configStatus.textContent = "Extension error: " + chrome.runtime.lastError.message;
      return;
    }

    if (!response) {
      configStatus.className = "status error";
      configStatus.textContent = "No response from background.";
      return;
    }

    if (response.error) {
      configStatus.className = "status error";
      configStatus.textContent = response.error;
      return;
    }

    configStatus.className = "status success";
    configStatus.textContent = response.servers.length + " server(s) found.";

    chrome.storage.local.set({ mcpConfigPath: path });

    chrome.storage.local.get(["mcpServerToggles"], function (data) {
      renderServerList(response.servers, data.mcpServerToggles || {});
    });
  });
});

configPathInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") loadBtn.click();
});

// --- Render Server List ---

function renderServerList(servers, toggles) {
  serverListEl.innerHTML = "";

  if (!servers || servers.length === 0) {
    serverListEl.innerHTML = '<div class="empty-state">No servers found in config.</div>';
    return;
  }

  servers.forEach(function (server) {
    var enabled = toggles[server.name] !== false; // default ON

    var item = document.createElement("div");
    item.className = "server-item";

    var transport = server.transport || "stdio";
    var detail = transport === "http" ? server.url : server.command;

    item.innerHTML =
      '<div class="server-info">' +
        '<div class="server-name">' + escapeHtml(server.name) + '</div>' +
        '<div class="server-meta">' + escapeHtml(transport) + ' \u00b7 ' + escapeHtml(detail || "") + '</div>' +
      '</div>' +
      '<label class="toggle">' +
        '<input type="checkbox" data-server="' + escapeHtml(server.name) + '"' + (enabled ? " checked" : "") + '>' +
        '<span class="toggle-slider"></span>' +
      '</label>';

    serverListEl.appendChild(item);
  });

  // Toggle handlers
  serverListEl.querySelectorAll('input[type="checkbox"]').forEach(function (checkbox) {
    checkbox.addEventListener("change", function () {
      var serverName = this.getAttribute("data-server");
      var isEnabled = this.checked;

      chrome.storage.local.get(["mcpServerToggles"], function (data) {
        var toggles = data.mcpServerToggles || {};
        toggles[serverName] = isEnabled;
        chrome.storage.local.set({ mcpServerToggles: toggles });

        // Notify background to update Clay tabs
        chrome.runtime.sendMessage({
          type: "mcp_server_toggle",
          server: serverName,
          enabled: isEnabled
        });
      });
    });
  });
}

// --- Native Host Check ---

function checkNativeHost() {
  chrome.runtime.sendMessage({ type: "mcp_check_host" }, function (response) {
    if (chrome.runtime.lastError || !response) {
      hostStatusEl.innerHTML =
        '<span class="dot dot-unknown"></span>' +
        '<span>Cannot reach background.</span>';
      return;
    }

    if (response.connected) {
      hostStatusEl.innerHTML =
        '<span class="dot dot-ok"></span>' +
        '<span>Connected</span>';
    } else {
      hostStatusEl.innerHTML =
        '<span class="dot dot-error"></span>' +
        '<span>Not installed. Set up in Clay settings.</span>';
    }
  });
}

// --- Util ---

function escapeHtml(str) {
  var div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
