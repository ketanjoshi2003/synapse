// background.js — Synapse service worker

const MAX_LOG = 50;

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Relay to popup if open
  if (['SYNC_EVENT', 'WS_STATUS', 'SERVER_INFO'].includes(msg.type)) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  // Persist sync events so log survives popup close/open
  if (msg.type === 'SYNC_EVENT') {
    chrome.storage.local.get({ syncLog: [], syncStats: { created: 0, updated: 0, patches: 0, errors: 0 } }, (data) => {
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
        if (['patch', 'search_replace', 'smart_patch'].includes(msg.mode)) {
          stats.patches = (stats.patches || 0) + 1;
        } else if (msg.message?.includes('Created')) {
          stats.created = (stats.created || 0) + 1;
        } else {
          stats.updated = (stats.updated || 0) + 1;
        }
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
