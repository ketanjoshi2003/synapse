// ─── Broadcast to all AI tabs ─────────────────────────────────────────────────

const AI_PATTERNS = [
  'https://claude.ai/',
  'https://chat.openai.com/',
  'https://chatgpt.com/',
  'https://gemini.google.com/',
  'https://chat.deepseek.com/',
  'https://copilot.microsoft.com/',
  'https://grok.x.ai/',
  'https://poe.com/',
  'https://chat.mistral.ai/',
  'https://huggingface.co/chat/'
];

function broadcastToAITabs(message, callback) {
  chrome.tabs.query({}, (tabs) => {
    let sent = 0;
    for (const tab of tabs) {
      if (!tab.url) continue;
      if (AI_PATTERNS.some(p => tab.url.startsWith(p))) {
        chrome.tabs.sendMessage(tab.id, message, () => {
          chrome.runtime.lastError; // suppress error
        });
        sent++;
      }
    }
    if (callback) callback(sent);
  });
}

// popup.js — Synapse v2

const $ = (id) => document.getElementById(id);
const statusDot = $('statusDot');
const statusText = $('statusText');
const statusMeta = $('statusMeta');
const portInput = $('portInput');
const log = $('log');
const autoSyncToggle = $('autoSyncToggle');
const dryRunToggle = $('dryRunToggle');
const gitBackupToggle = $('gitBackupToggle');

let stats = { files: 0, patches: 0, errors: 0 };

// ─── Load persisted state, then verify with live ping ────────────────────────

chrome.storage.local.get([
  'wsPort', 'autoSync', 'dryRun', 'gitBackup',
  'syncStats', 'syncLog', 'runtimeStatus', 'serverInfo'
], (data) => {
  if (data.wsPort) portInput.value = data.wsPort;
  autoSyncToggle.checked = data.autoSync !== false;
  dryRunToggle.checked = data.dryRun === true;
  gitBackupToggle.checked = data.gitBackup === true;

  if (data.syncStats) {
    stats = data.syncStats;
    updateStats();
  }

  if (Array.isArray(data.syncLog) && data.syncLog.length > 0) {
    log.innerHTML = '';
    data.syncLog.forEach(e => addLogEntry(e.filename, e.status, e.mode, e.timestamp));
  }

  // Show stored status initially, then immediately verify with live ping
  const storedStatus = data.runtimeStatus;
  const serverInfo = data.serverInfo;

  if (storedStatus) {
    setStatus(storedStatus.connected, storedStatus.platform, serverInfo?.outputDir);
  }

  // ── Live ping — always overrides stored status ──────────────────────────
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      // No active tab — can't verify, mark offline
      setStatus(false, null, serverInfo?.outputDir);
      chrome.storage.local.set({ runtimeStatus: { connected: false, platform: null } });
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, { type: 'PING' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        // Content script not responding — definitely offline
        setStatus(false, null, serverInfo?.outputDir);
        chrome.storage.local.set({ runtimeStatus: { connected: false, platform: null } });
        return;
      }
      // Got live response — use it (truth source)
      setStatus(res.connected, res.platform, serverInfo?.outputDir);
      chrome.storage.local.set({ runtimeStatus: { connected: res.connected, platform: res.platform } });
    });
  });
});

// ─── Buttons ──────────────────────────────────────────────────────────────────

$('saveBtn').addEventListener('click', () => {
  const port = parseInt(portInput.value);
  chrome.storage.local.set({ wsPort: port });
  broadcastToAITabs({ type: 'UPDATE_PORT', port }, (sent) => {
    const btn = $('saveBtn');
    btn.textContent = sent > 0 ? '✓ Reconnecting...' : '✓ Saved!';
    setTimeout(() => { btn.textContent = 'Save & Reconnect'; }, 1500);
  });
});

$('scanBtn').addEventListener('click', () => {
  broadcastToAITabs({ type: 'SCAN_NOW' });
  const btn = $('scanBtn');
  btn.textContent = 'Scanning…';
  setTimeout(() => { btn.textContent = 'Scan Now'; }, 1200);
});

autoSyncToggle.addEventListener('change', () => {
  const enabled = autoSyncToggle.checked;
  chrome.storage.local.set({ autoSync: enabled });
  broadcastToAITabs({ type: 'SET_AUTO_SYNC', enabled });
});

dryRunToggle.addEventListener('change', () => {
  chrome.storage.local.set({ dryRun: dryRunToggle.checked });
});

gitBackupToggle.addEventListener('change', () => {
  chrome.storage.local.set({ gitBackup: gitBackupToggle.checked });
});

$('clearLogBtn').addEventListener('click', () => {
  log.innerHTML = '<div class="log-empty">No sync activity yet.</div>';
  stats = { files: 0, patches: 0, errors: 0 };
  chrome.storage.local.set({ syncStats: stats, syncLog: [] });
  updateStats();
});

// ─── Live messages while popup is open ───────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SYNC_EVENT') {
    // Stats are persisted by background.js; just update display
    if (msg.status === 'ok') {
      if (msg.mode === 'patch') stats.patches++;
      else stats.files++;
    } else {
      stats.errors++;
    }
    updateStats();
    addLogEntry(msg.filename, msg.status, msg.mode, Date.now());
  }
  if (msg.type === 'WS_STATUS') {
    setStatus(msg.connected, msg.platform);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(connected, platform, outputDir) {
  statusDot.className = 'dot ' + (connected ? 'on' : 'off');
  const name = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : '';
  if (connected) {
    statusText.textContent = 'Connected to local server';
    statusText.style.color = '#00ff88';
    statusMeta.textContent = name ? `Watching ${name}` : 'Ready';
  } else {
    statusText.textContent = 'Server offline';
    statusText.style.color = '#ff5f5f';
    statusMeta.textContent = outputDir
      ? `Last target: ${outputDir}`
      : 'Run: node server.js --output <dir>';
  }
}

function updateStats() {
  $('statFiles').textContent = stats.files || 0;
  $('statPatches').textContent = stats.patches || 0;
  $('statErrors').textContent = stats.errors || 0;
}

function addLogEntry(filename, status, mode, timestamp) {
  const empty = log.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const isOk = status === 'ok';
  const icons = { overwrite: 'W', patch: 'P', insert: '+', delete: '-' };
  const icon = isOk ? (icons[mode] || 'W') : '!';
  const time = new Date(timestamp || Date.now()).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  const iconEl = document.createElement('span');
  iconEl.className = 'log-icon';
  iconEl.textContent = icon;

  const fileEl = document.createElement('span');
  fileEl.className = 'log-file';
  fileEl.textContent = filename;
  fileEl.style.color = isOk ? 'rgba(0,255,136,.85)' : 'rgba(255,95,95,.9)';

  const timeEl = document.createElement('span');
  timeEl.className = 'log-time';
  timeEl.textContent = time;

  entry.append(iconEl, fileEl, timeEl);
  log.prepend(entry);

  while (log.children.length > 50) log.removeChild(log.lastChild);
}
