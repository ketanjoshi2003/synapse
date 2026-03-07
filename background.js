// background.js — Synapse v2 service worker

const MAX_LOG = 50;

const SUPPORTED_PATTERNS = [
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

// ─── Inject into already-open AI tabs (no refresh needed) ────────────────────

function injectIntoOpenTabs() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.url) continue;
      const isSupported = SUPPORTED_PATTERNS.some(p => tab.url.startsWith(p));
      if (isSupported) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        }).catch(() => {}); // Tab may not be ready — silently skip
      }
    }
  });
}

chrome.runtime.onInstalled.addListener(injectIntoOpenTabs);
chrome.runtime.onStartup.addListener(injectIntoOpenTabs);

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Relay to popup if open
  if (['SYNC_EVENT', 'WS_STATUS', 'SERVER_INFO'].includes(msg.type)) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  // Persist sync events so log survives popup close/open
  if (msg.type === 'SYNC_EVENT') {
    chrome.storage.local.get({ syncLog: [], syncStats: { files: 0, patches: 0, errors: 0 } }, (data) => {
      const log = data.syncLog;
      const stats = data.syncStats;

      log.unshift({
        filename: msg.filename,
        status: msg.status,
        mode: msg.mode,
        timestamp: Date.now()
      });
      if (log.length > MAX_LOG) log.length = MAX_LOG;

      if (msg.status === 'ok') {
        if (msg.mode === 'patch') stats.patches = (stats.patches || 0) + 1;
        else stats.files = (stats.files || 0) + 1;
      } else {
        stats.errors = (stats.errors || 0) + 1;
      }

      chrome.storage.local.set({ syncLog: log, syncStats: stats });
    });
  }

  // Persist connection status
  if (msg.type === 'WS_STATUS') {
    chrome.storage.local.set({
      runtimeStatus: { connected: msg.connected, platform: msg.platform }
    });
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }

  // Persist server info
  if (msg.type === 'SERVER_INFO') {
    chrome.storage.local.set({ serverInfo: msg });
  }
});
