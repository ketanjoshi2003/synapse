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
          chrome.runtime.lastError;
        });
        sent++;
      }
    }
    if (callback) callback(sent);
  });
}

// popup.js — Synapse v3

const $ = (id) => document.getElementById(id);
const statusDot = $('statusDot');
const statusText = $('statusText');
const statusMeta = $('statusMeta');
const targetDir = $('targetDir');
const portInput = $('portInput');
const log = $('log');
const autoSyncToggle = $('autoSyncToggle');
const dryRunToggle = $('dryRunToggle');
const gitBackupToggle = $('gitBackupToggle');

let stats = { created: 0, updated: 0, patches: 0, errors: 0 };

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

  const storedStatus = data.runtimeStatus;
  const serverInfo = data.serverInfo;

  if (serverInfo?.outputDir) {
    setTargetDir(serverInfo.outputDir);
  }

  if (storedStatus) {
    setStatus(storedStatus.connected, storedStatus.platform, serverInfo?.outputDir);
  }

  // Live ping to verify connection
  function checkDirectly(tab) {
    try {
      const port = portInput.value || 3131;
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.onopen = () => {
        let meta = 'Ready / Waiting for AI tab';
        if (tab?.url) {
          const platforms = ['claude.ai', 'chat.openai.com', 'chatgpt.com', 'gemini.google',
            'chat.deepseek', 'copilot.microsoft', 'grok.x.ai', 'poe.com', 'chat.mistral', 'huggingface.co'];
          if (platforms.some(p => tab.url.includes(p))) {
            meta = 'Please refresh this tab to connect';
            statusMeta.style.color = '#f59e0b';
          }
        }
        setStatus(true, null, serverInfo?.outputDir, meta);
        ws.close();
      };
      ws.onerror = () => {
        setStatus(false, null, serverInfo?.outputDir);
        chrome.storage.local.set({ runtimeStatus: { connected: false, platform: null } });
      };
    } catch (e) {
      setStatus(false, null, serverInfo?.outputDir);
    }
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) { checkDirectly(null); return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'PING' }, (res) => {
      if (chrome.runtime.lastError || !res) { checkDirectly(tabs[0]); return; }
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
    btn.textContent = sent > 0 ? '\u2713 Reconnecting...' : '\u2713 Saved!';
    setTimeout(() => { btn.textContent = 'Save & Reconnect'; }, 1500);
  });
});

$('scanBtn').addEventListener('click', () => {
  broadcastToAITabs({ type: 'SCAN_NOW' });
  const btn = $('scanBtn');
  btn.textContent = 'Scanning\u2026';
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
  stats = { created: 0, updated: 0, patches: 0, errors: 0 };
  chrome.storage.local.set({ syncStats: stats, syncLog: [] });
  updateStats();
});

// ─── Live messages while popup is open ───────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SYNC_EVENT') {
    if (msg.status === 'ok') {
      if (['patch', 'search_replace', 'smart_patch'].includes(msg.mode)) {
        stats.patches++;
      } else if (msg.message?.includes('Created')) {
        stats.created++;
      } else {
        stats.updated++;
      }
    } else {
      stats.errors++;
    }
    updateStats();
    addLogEntry(msg.filename, msg.status, msg.mode, Date.now());
  }
  if (msg.type === 'WS_STATUS') {
    setStatus(msg.connected, msg.platform);
  }
  if (msg.type === 'SERVER_INFO') {
    if (msg.outputDir) setTargetDir(msg.outputDir);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setTargetDir(dir) {
  if (!dir) return;
  targetDir.textContent = dir;
  targetDir.classList.remove('empty');
  targetDir.title = dir;
}

function setStatus(connected, platform, outputDir, overrideMeta = null) {
  statusDot.className = 'dot ' + (connected ? 'on' : 'off');
  statusMeta.style.color = '';
  const name = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : '';
  if (connected) {
    statusText.textContent = 'Connected to local server';
    statusText.style.color = '#10b981';
    statusMeta.textContent = overrideMeta || (name ? `Watching ${name}` : 'Ready / Waiting for AI tab');
  } else {
    statusText.textContent = 'Server offline';
    statusText.style.color = '#ef4444';
    statusMeta.textContent = outputDir
      ? `Last target: ${outputDir}`
      : 'Run: node server.js --output <dir>';
  }
}

function updateStats() {
  $('statCreated').textContent = stats.created || 0;
  $('statUpdated').textContent = stats.updated || 0;
  $('statPatches').textContent = stats.patches || 0;
  $('statErrors').textContent = stats.errors || 0;
}

function addLogEntry(filename, status, mode, timestamp) {
  const empty = log.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const isOk = status === 'ok';

  const modeIcons = {
    overwrite: 'W', patch: 'P', insert: '+', delete: '-',
    search_replace: 'E', smart_patch: 'S', create: 'C'
  };
  const icon = isOk ? (modeIcons[mode] || 'W') : '!';

  const modeLabels = {
    overwrite: 'write', patch: 'patch', insert: 'ins', delete: 'del',
    search_replace: 'edit', smart_patch: 'smart', create: 'new'
  };

  const time = new Date(timestamp || Date.now()).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  const iconEl = document.createElement('span');
  iconEl.className = 'log-icon';
  iconEl.textContent = icon;

  const fileEl = document.createElement('span');
  fileEl.className = 'log-file';
  fileEl.textContent = filename || 'unknown';
  fileEl.style.color = isOk ? 'rgba(16, 185, 129, 0.9)' : 'rgba(239, 68, 68, 0.9)';

  const modeEl = document.createElement('span');
  modeEl.className = 'log-mode';
  modeEl.textContent = modeLabels[mode] || mode || 'sync';

  const timeEl = document.createElement('span');
  timeEl.className = 'log-time';
  timeEl.textContent = time;

  entry.append(iconEl, fileEl, modeEl, timeEl);
  log.prepend(entry);

  while (log.children.length > 50) log.removeChild(log.lastChild);
}
