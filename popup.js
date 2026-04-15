// Clay Chrome Extension - Popup
// MCP server management: add/remove servers, import external configs

var serverListEl = document.getElementById("serverList");
var hostStatusEl = document.getElementById("hostStatus");
var addForm = document.getElementById("addForm");
var addServerBtn = document.getElementById("addServerBtn");
var cancelAddBtn = document.getElementById("cancelAddBtn");
var saveServerBtn = document.getElementById("saveServerBtn");
var serverNameInput = document.getElementById("serverName");
var serverPackageInput = document.getElementById("serverPackage");
var envFieldsEl = document.getElementById("envFields");
var addEnvBtn = document.getElementById("addEnvBtn");
var importPathInput = document.getElementById("importPath");
var importBtn = document.getElementById("importBtn");
var importStatus = document.getElementById("importStatus");
var importedPathsEl = document.getElementById("importedPaths");

// --- Init ---

checkNativeHost();
loadServers();
loadImportedPaths();

// --- Server List ---

function loadServers() {
  chrome.runtime.sendMessage({ type: "mcp_get_servers" }, function (response) {
    if (chrome.runtime.lastError || !response) {
      // Native host not available, try cached
      chrome.storage.local.get(["mcpServers"], function (data) {
        renderServerList(data.mcpServers || []);
      });
      return;
    }
    renderServerList(response.servers || []);
  });
}

function renderServerList(servers) {
  serverListEl.innerHTML = "";

  if (!servers || servers.length === 0) {
    serverListEl.innerHTML = '<div class="empty-state">No servers configured.</div>';
    return;
  }

  servers.forEach(function (server) {
    var item = document.createElement("div");
    item.className = "server-item";

    var transport = server.transport || "stdio";
    var detail = transport === "http" ? server.url : server.command;
    var statusDot = server.running ? "dot-ok" : "dot-off";

    item.innerHTML =
      '<div class="server-info">' +
        '<span class="dot ' + statusDot + '"></span>' +
        '<div>' +
          '<div class="server-name">' + escapeHtml(server.name) + '</div>' +
          '<div class="server-meta">' + escapeHtml(detail || transport) + '</div>' +
        '</div>' +
      '</div>' +
      '<button class="remove-btn" data-server="' + escapeHtml(server.name) + '" title="Remove">&times;</button>';

    serverListEl.appendChild(item);
  });

  // Remove handlers
  serverListEl.querySelectorAll(".remove-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var name = this.getAttribute("data-server");
      chrome.runtime.sendMessage({
        type: "mcp_remove_server",
        name: name
      }, function () {
        loadServers();
      });
    });
  });
}

// --- Add Server Form ---

addServerBtn.addEventListener("click", function () {
  addForm.classList.remove("hidden");
  serverNameInput.value = "";
  serverPackageInput.value = "";
  envFieldsEl.innerHTML = "";
  serverNameInput.focus();
});

cancelAddBtn.addEventListener("click", function () {
  addForm.classList.add("hidden");
});

addEnvBtn.addEventListener("click", function () {
  addEnvRow("", "");
});

function addEnvRow(key, value) {
  var row = document.createElement("div");
  row.className = "env-row";
  row.innerHTML =
    '<input type="text" class="env-key" placeholder="KEY" value="' + escapeHtml(key) + '" spellcheck="false">' +
    '<input type="text" class="env-val" placeholder="value" value="' + escapeHtml(value) + '" spellcheck="false">' +
    '<button class="env-remove" title="Remove">&times;</button>';
  row.querySelector(".env-remove").addEventListener("click", function () {
    row.remove();
  });
  envFieldsEl.appendChild(row);
}

saveServerBtn.addEventListener("click", function () {
  var name = serverNameInput.value.trim();
  var pkg = serverPackageInput.value.trim();
  if (!name || !pkg) return;

  var env = {};
  envFieldsEl.querySelectorAll(".env-row").forEach(function (row) {
    var k = row.querySelector(".env-key").value.trim();
    var v = row.querySelector(".env-val").value.trim();
    if (k) env[k] = v;
  });

  chrome.runtime.sendMessage({
    type: "mcp_add_server",
    name: name,
    command: "npx",
    args: ["-y", pkg],
    env: env
  }, function (response) {
    if (chrome.runtime.lastError || (response && response.error)) {
      return;
    }
    addForm.classList.add("hidden");
    loadServers();
  });
});

// --- Import External Config ---

importBtn.addEventListener("click", function () {
  var path = importPathInput.value.trim();
  if (!path) return;

  chrome.runtime.sendMessage({
    type: "mcp_import_config",
    path: path
  }, function (response) {
    if (chrome.runtime.lastError || !response) {
      importStatus.className = "status error";
      importStatus.textContent = "Failed to reach native host.";
      return;
    }
    if (response.error) {
      importStatus.className = "status error";
      importStatus.textContent = response.error;
      return;
    }
    importStatus.className = "status success";
    importStatus.textContent = (response.count || 0) + " server(s) imported.";
    importPathInput.value = "";
    loadServers();
    loadImportedPaths();
  });
});

importPathInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") importBtn.click();
});

function loadImportedPaths() {
  chrome.runtime.sendMessage({ type: "mcp_get_imports" }, function (response) {
    if (chrome.runtime.lastError || !response || !response.paths) {
      importedPathsEl.innerHTML = "";
      return;
    }
    importedPathsEl.innerHTML = "";
    response.paths.forEach(function (p) {
      var tag = document.createElement("div");
      tag.className = "import-tag";
      tag.innerHTML = '<span class="import-path">' + escapeHtml(p) + '</span>'
        + '<button class="import-remove" data-path="' + escapeHtml(p) + '">&times;</button>';
      tag.querySelector(".import-remove").addEventListener("click", function () {
        chrome.runtime.sendMessage({ type: "mcp_remove_import", path: p }, function () {
          loadImportedPaths();
          loadServers();
        });
      });
      importedPathsEl.appendChild(tag);
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
      var extId = chrome.runtime.id;
      var cmd = "npx clay-mcp-bridge install " + extId;
      hostStatusEl.innerHTML =
        '<span class="dot dot-error"></span>' +
        '<span>Not installed</span>';
      // Show install guide below
      var existing = document.getElementById("hostInstallGuide");
      if (!existing) {
        var guide = document.createElement("div");
        guide.id = "hostInstallGuide";
        guide.style.cssText = "margin-top:8px;font-size:11px;color:var(--text-dim);line-height:1.5";
        guide.innerHTML =
          '<div style="margin-bottom:4px">Run in your terminal:</div>' +
          '<code style="display:block;background:var(--bg-card);padding:6px 8px;border-radius:5px;font-size:11px;cursor:pointer;border:1px solid var(--border)" title="Click to copy">' + escapeHtml(cmd) + '</code>' +
          '<div style="margin-top:6px;color:var(--text-dimmer)">Then restart your browser.</div>';
        guide.querySelector("code").addEventListener("click", function () {
          navigator.clipboard.writeText(cmd).then(function () {
            guide.querySelector("code").textContent = "Copied!";
            setTimeout(function () { guide.querySelector("code").textContent = cmd; }, 1500);
          });
        });
        hostStatusEl.parentNode.appendChild(guide);
      }
    }
  });
}

// --- Util ---

function escapeHtml(str) {
  var div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
