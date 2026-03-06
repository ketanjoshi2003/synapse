// content.js — Synapse v2
// The neural link between AI and your codebase
// Supports: Claude, ChatGPT, Gemini, DeepSeek, Copilot, Grok, Poe, Mistral, HuggingFace

let ws = null;
let wsPort = 3131;
let isConnected = false;
let autoSync = true;
let sentHashes = new Set();
let pendingCode = [];
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let heartbeatInterval = null;

// ─── Platform Detection ──────────────────────────────────────────────────────

function detectPlatform() {
  const host = window.location.hostname;
  if (host.includes('claude.ai')) return 'claude';
  if (host.includes('chat.openai.com')) return 'chatgpt';
  if (host.includes('chatgpt.com')) return 'chatgpt';
  if (host.includes('gemini.google')) return 'gemini';
  if (host.includes('chat.deepseek')) return 'deepseek';
  if (host.includes('copilot.microsoft')) return 'copilot';
  if (host.includes('grok.x.ai')) return 'grok';
  if (host.includes('poe.com')) return 'poe';
  if (host.includes('chat.mistral')) return 'mistral';
  if (host.includes('huggingface.co')) return 'huggingface';
  return 'unknown';
}

const PLATFORM = detectPlatform();

// ─── Platform-specific selectors for assistant messages ───────────────────────

const ASSISTANT_SELECTORS = {
  claude: [
    '[data-testid="assistant-message"]',
    '.font-claude-message',
    '[class*="AssistantMessage"]',
    '[class*="assistant-message"]'
  ],
  chatgpt: [
    '[data-message-author-role="assistant"]',
    '.agent-turn',
    '[class*="assistant"]',
    '.markdown'
  ],
  gemini: [
    '.model-response-text',
    '.response-container',
    'message-content[class*="model"]',
    '[class*="response"]'
  ],
  deepseek: [
    '.ds-markdown--block',
    '[class*="assistant"]',
    '.markdown-body'
  ],
  copilot: [
    '[data-content="ai-message"]',
    '.response-message-text',
    '[class*="response"]'
  ],
  grok: [
    '[class*="message"][class*="bot"]',
    '[class*="assistant"]',
    '.message-content'
  ],
  poe: [
    '[class*="BotMessage"]',
    '[class*="bot_message"]',
    '.Message_botMessage'
  ],
  mistral: [
    '[class*="assistant"]',
    '.prose',
    '.message-content'
  ],
  huggingface: [
    '.message.assistant',
    '[class*="assistant"]'
  ],
  unknown: []
};

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connectWebSocket() {
  try { ws = new WebSocket(`ws://localhost:${wsPort}`); }
  catch (e) { scheduleReconnect(); return; }

  ws.onopen = () => {
    isConnected = true;
    reconnectDelay = 1000; // Reset backoff
    showBadge(true);
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: true, platform: PLATFORM }).catch(() => { });
    // Flush pending queue
    pendingCode.forEach(d => ws.send(JSON.stringify(d)));
    pendingCode = [];
    startHeartbeat();
    console.log(`[Synapse] ✅ Connected to server (platform: ${PLATFORM})`);
  };

  ws.onclose = () => {
    isConnected = false;
    showBadge(false);
    stopHeartbeat();
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false, platform: PLATFORM }).catch(() => { });
    scheduleReconnect();
  };

  ws.onerror = () => { isConnected = false; showBadge(false); };

  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'pong') return; // heartbeat response
      if (d.type === 'ACK') {
        chrome.runtime.sendMessage({
          type: 'SYNC_EVENT',
          filename: d.filename,
          status: d.status,
          message: d.message,
          mode: d.mode,
          platform: PLATFORM
        }).catch(() => { });
        console.log(`[Synapse] ACK: ${d.status} → ${d.filename} (${d.message})`);
        showToast(d.filename, d.status, d.mode);
      }
      if (d.type === 'SERVER_INFO') {
        chrome.runtime.sendMessage({ type: 'SERVER_INFO', ...d }).catch(() => { });
      }
    } catch (_) { }
  };
}

function scheduleReconnect() {
  setTimeout(connectWebSocket, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 15000);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// ─── Hash (dedup) ─────────────────────────────────────────────────────────────

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h.toString();
}

// ─── Filename extraction ──────────────────────────────────────────────────────
// Supports many comment styles:
//   // path/file.ext     → JS/TS/C/C++/Java/Go/Rust/etc
//   # path/file.ext      → Python/Ruby/Bash/YAML/Dockerfile
//   -- path/file.ext     → SQL/Haskell/Lua
//   /* path/file.ext */  → CSS/C multi-line
//   <!-- path/file.ext -->  → HTML/XML
//   ; path/file.ext      → INI/Lisp/Assembly
//   % path/file.ext      → LaTeX/Matlab/Erlang  
//   rem path/file.ext    → Batch

function extractFilename(code) {
  const firstLine = code.split('\n')[0].trim();

  const patterns = [
    /^(?:\/\/|#|--)\s+([\w][\w/\\\-.]*\.\w{1,10})$/,                  // // # --
    /^\/\*\s*([\w][\w/\\\-.]*\.\w{1,10})\s*\*\/$/,                     // /* ... */
    /^<!--\s*([\w][\w/\\\-.]*\.\w{1,10})\s*-->$/,                      // <!-- ... -->
    /^;\s*([\w][\w/\\\-.]*\.\w{1,10})$/,                               // ;
    /^%\s*([\w][\w/\\\-.]*\.\w{1,10})$/,                               // %
    /^rem\s+([\w][\w/\\\-.]*\.\w{1,10})$/i,                            // rem (batch)
    /^(?:\/\/|#|--)\s*(?:file|path|filename):\s*([\w][\w/\\\-.]*\.\w{1,10})$/i, // // file: path/f.ext
  ];

  for (const pat of patterns) {
    const m = firstLine.match(pat);
    if (m) {
      const filename = m[1];
      if (!isBlockedFile(filename)) return filename;
      return null;
    }
  }

  return null;
}

function isBlockedFile(filename) {
  const blocked = [
    'manifest.json', 'content.js', 'background.js',
    'popup.js', 'popup.html', 'package-lock.json'
  ];
  const basename = filename.split('/').pop().split('\\').pop();
  return blocked.includes(basename);
}

// ─── Extract code blocks ──────────────────────────────────────────────────────

function extractCodeBlocks() {
  if (!autoSync) return;

  const selectors = ASSISTANT_SELECTORS[PLATFORM] || [];
  let containers = [];

  for (const sel of selectors) {
    try {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) { containers = [...found]; break; }
    } catch (_) { }
  }

  // Fallback: all pre>code on page
  if (containers.length === 0) {
    document.querySelectorAll('pre code').forEach(processBlock);
    return;
  }

  containers.forEach(c => c.querySelectorAll('pre code').forEach(processBlock));
}

function processBlock(block) {
  const raw = block.innerText?.trim();
  if (!raw || raw.length < 10) return;

  // Dedup
  const h = hash(raw);
  if (sentHashes.has(h)) return;

  // Strict filename check
  const filename = extractFilename(raw);
  if (!filename) return;

  sentHashes.add(h);

  const payload = {
    type: 'code_block',
    timestamp: Date.now(),
    language: detectLanguage(block),
    filename,
    code: raw,
    platform: PLATFORM,
    conversationId: getConversationId()
  };

  sendToServer(payload);
  glow(block);
  console.log(`[Synapse] → Queued: ${filename}`);
}

function detectLanguage(block) {
  const classes = [...(block.className?.split(' ') || []), ...(block.parentElement?.className?.split(' ') || [])];
  for (const c of classes) {
    const m = c.match(/language-(\w+)/);
    if (m) return m[1];
  }
  return 'plaintext';
}

function getConversationId() {
  const host = window.location.hostname;
  const path = window.location.pathname;

  // Claude: /chat/<id>
  let m = path.match(/\/chat\/([a-zA-Z0-9-]+)/);
  if (m) return m[1];

  // ChatGPT: /c/<id>
  m = path.match(/\/c\/([a-zA-Z0-9-]+)/);
  if (m) return m[1];

  // Gemini: /app/<id>
  m = path.match(/\/app\/([a-zA-Z0-9-]+)/);
  if (m) return m[1];

  // Generic fallback
  m = path.match(/([a-f0-9-]{8,})/);
  if (m) return m[1];

  return 'unknown';
}

// ─── DOM Observer ─────────────────────────────────────────────────────────────

function startObserver() {
  let scanTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(extractCodeBlocks, 1500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  console.log(`[Synapse] Observer active ✅ (${PLATFORM})`);
}

// ─── Send ─────────────────────────────────────────────────────────────────────

function sendToServer(payload) {
  if (isConnected && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    pendingCode.push(payload);
    // Cap pending queue
    if (pendingCode.length > 100) pendingCode.shift();
  }
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function showBadge(connected) {
  let b = document.getElementById('acs-badge');
  if (!b) {
    b = document.createElement('div');
    b.id = 'acs-badge';
    b.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 99999;
      padding: 8px 14px; border-radius: 24px;
      font-size: 12px; font-family: -apple-system, 'Segoe UI', monospace;
      font-weight: 600; letter-spacing: 0.3px;
      box-shadow: 0 4px 16px rgba(0,0,0,.4);
      backdrop-filter: blur(12px);
      transition: all .4s cubic-bezier(.4,0,.2,1);
      cursor: pointer; user-select: none;
    `;
    b.addEventListener('click', () => { b.style.opacity = b.style.opacity === '0.1' ? '1' : '0.1'; });
    document.body.appendChild(b);
  }
  b.textContent = connected ? '🔗 Synapse: ON' : '⚠ Synapse: OFF';
  b.style.background = connected
    ? 'linear-gradient(135deg, rgba(0,255,136,.15), rgba(0,255,136,.05))'
    : 'linear-gradient(135deg, rgba(255,107,107,.15), rgba(255,107,107,.05))';
  b.style.color = connected ? '#00ff88' : '#ff6b6b';
  b.style.border = `1px solid ${connected ? 'rgba(0,255,136,.3)' : 'rgba(255,107,107,.3)'}`;
}

function showToast(filename, status, mode) {
  const t = document.createElement('div');
  const isOk = status === 'ok';
  t.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 100000;
    padding: 12px 20px; border-radius: 12px;
    font-size: 13px; font-family: -apple-system, 'Segoe UI', monospace;
    font-weight: 500;
    box-shadow: 0 8px 32px rgba(0,0,0,.5);
    backdrop-filter: blur(16px);
    transform: translateX(120%);
    transition: transform .4s cubic-bezier(.4,0,.2,1), opacity .4s;
    background: ${isOk
      ? 'linear-gradient(135deg, rgba(0,255,136,.12), rgba(0,180,100,.08))'
      : 'linear-gradient(135deg, rgba(255,107,107,.12), rgba(200,50,50,.08))'};
    color: ${isOk ? '#00ff88' : '#ff6b6b'};
    border: 1px solid ${isOk ? 'rgba(0,255,136,.2)' : 'rgba(255,107,107,.2)'};
  `;
  const modeIcon = { overwrite: '📝', patch: '🔧', insert: '➕', delete: '🗑️' };
  t.textContent = `${isOk ? '✅' : '❌'} ${modeIcon[mode] || '📦'} ${filename}`;
  document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.transform = 'translateX(0)'; });
  setTimeout(() => {
    t.style.transform = 'translateX(120%)';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 500);
  }, 3000);
}

function glow(block) {
  const pre = block.closest('pre') || block;
  pre.style.outline = '2px solid rgba(0,255,136,.4)';
  pre.style.outlineOffset = '2px';
  pre.style.transition = 'outline .3s, outline-offset .3s';
  setTimeout(() => { pre.style.outline = 'none'; pre.style.outlineOffset = '0'; }, 2500);
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ connected: isConnected, platform: PLATFORM, autoSync, queueSize: pendingCode.length });
    return true;
  }
  if (msg.type === 'SCAN_NOW') extractCodeBlocks();
  if (msg.type === 'UPDATE_PORT') { wsPort = msg.port; ws?.close(); }
  if (msg.type === 'SET_AUTO_SYNC') { autoSync = msg.enabled; }
  if (msg.type === 'CLEAR_CACHE') { sentHashes.clear(); }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

chrome.storage.local.get(['wsPort', 'autoSync'], (r) => {
  if (r.wsPort) wsPort = r.wsPort;
  if (r.autoSync !== undefined) autoSync = r.autoSync;
  connectWebSocket();
  startObserver();
  console.log(`[Synapse] Initialized on ${PLATFORM}`);
});
