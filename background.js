// background.js — Synapse v2 service worker

// Relay messages from content script to popup
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (['SYNC_EVENT', 'WS_STATUS', 'SERVER_INFO'].includes(msg.type)) {
    chrome.runtime.sendMessage(msg).catch(() => { });
  }
});

// Set badge text based on connection status
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WS_STATUS') {
    const text = msg.connected ? 'ON' : 'OFF';
    const color = msg.connected ? '#00ff88' : '#ff6b6b';
    chrome.action.setBadgeText({ text }).catch(() => { });
    chrome.action.setBadgeBackgroundColor({ color }).catch(() => { });
  }
});
