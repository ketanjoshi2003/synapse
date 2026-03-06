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

chrome.storage.local.get(['wsPort', 'autoSync', 'dryRun', 'gitBackup', 'syncStats'], (data) => {
  if (data.wsPort) portInput.value = data.wsPort;
  autoSyncToggle.checked = data.autoSync !== false;
  dryRunToggle.checked = data.dryRun === true;
  gitBackupToggle.checked = data.gitBackup === true;
  if (data.syncStats) { stats = data.syncStats; updateStats(); }
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0]) return;
  try {
    chrome.tabs.sendMessage(tabs[0].id, { type: 'PING' }, (res) => {
      if (chrome.runtime.lastError) { setStatus(false, null); return; }
      setStatus(res?.connected || false, res?.platform || null);
      if (res?.queueSize > 0) statusMeta.textContent = `${res.queueSize} items queued`;
    });
  } catch (e) { setStatus(false, null); }
});

$('saveBtn').addEventListener('click', () => {
  const port = parseInt(portInput.value);
  chrome.storage.local.set({ wsPort: port });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'UPDATE_PORT', port });
  });
  const btn = $('saveBtn');
  btn.textContent = '✓ Saved!';
  setTimeout(() => { btn.textContent = 'Save & Reconnect'; }, 1500);
});

$('scanBtn').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN_NOW' });
  });
  const btn = $('scanBtn');
  btn.textContent = '⟳ Scanning…';
  setTimeout(() => { btn.textContent = '⟳ Scan Now'; }, 1200);
});

autoSyncToggle.addEventListener('change', () => {
  const enabled = autoSyncToggle.checked;
  chrome.storage.local.set({ autoSync: enabled });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'SET_AUTO_SYNC', enabled });
  });
});

dryRunToggle.addEventListener('change', () => {
  chrome.storage.local.set({ dryRun: dryRunToggle.checked });
});

gitBackupToggle.addEventListener('change', () => {
  chrome.storage.local.set({ gitBackup: gitBackupToggle.checked });
});

$('clearLogBtn').addEventListener('click', () => {
  log.innerHTML = '<div class="log-empty">No syncs yet…</div>';
  stats = { files: 0, patches: 0, errors: 0 };
  chrome.storage.local.set({ syncStats: stats });
  updateStats();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SYNC_EVENT') {
    addLogEntry(msg.filename, msg.status, msg.mode);
    if (msg.status === 'ok') {
      if (msg.mode === 'patch') stats.patches++;
      else stats.files++;
    } else { stats.errors++; }
    chrome.storage.local.set({ syncStats: stats });
    updateStats();
  }
  if (msg.type === 'WS_STATUS') setStatus(msg.connected, msg.platform);
});

function setStatus(connected, platform) {
  statusDot.className = 'dot ' + (connected ? 'on' : 'off');
  const name = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : '';
  if (connected) {
    statusText.textContent = 'Connected to local server';
    statusText.style.color = '#00ff88';
    statusMeta.textContent = name ? `Watching ${name}` : '';
  } else {
    statusText.textContent = 'Server offline';
    statusText.style.color = '#ff6b6b';
    statusMeta.textContent = 'Run: node server.js --output <dir>';
  }
}

function updateStats() {
  $('statFiles').textContent = stats.files;
  $('statPatches').textContent = stats.patches;
  $('statErrors').textContent = stats.errors;
}

function addLogEntry(filename, status, mode) {
  const empty = log.querySelector('.log-empty');
  if (empty) empty.remove();
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const isOk = status === 'ok';
  const icons = { overwrite: '📝', patch: '🔧', insert: '➕', delete: '🗑️' };
  const icon = isOk ? (icons[mode] || '✅') : '❌';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.innerHTML = `
    <span class="log-icon">${icon}</span>
    <span class="log-file" style="color:${isOk ? 'rgba(0,255,136,.8)' : 'rgba(255,107,107,.8)'}">${filename}</span>
    <span class="log-time">${time}</span>
  `;
  log.prepend(entry);
  while (log.children.length > 20) log.removeChild(log.lastChild);
}
