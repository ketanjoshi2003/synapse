// content.js — Synapse v2
// The neural link between AI and your codebase
// Supports: Claude, ChatGPT, Gemini, DeepSeek, Copilot, Grok, Poe, Mistral, HuggingFace

let ws = null;
let wsPort = 3131;
let isConnected = false;
let autoSync = true;
let sentHashes = new Set();
const HASH_STORAGE_KEY = 'synapseHashes';
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
    'article[data-testid*="conversation-turn"]',
    '.agent-turn',
    '[class*="markdown"]',
    '.prose'
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
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: true, platform: PLATFORM }).catch(() => { });
    // Flush pending queue
    pendingCode.forEach(d => ws.send(JSON.stringify(d)));
    pendingCode = [];
    startHeartbeat();
    console.log(`[Synapse] ✅ Connected to server (platform: ${PLATFORM})`);
  };

  ws.onclose = () => {
    isConnected = false;
    stopHeartbeat();
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false, platform: PLATFORM }).catch(() => { });
    scheduleReconnect();
  };

  ws.onerror = () => { isConnected = false; scheduleReconnect(); };

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
  const delay = reconnectDelay;
  reconnectDelay = delay === 0 ? 1000 : Math.min(delay * 1.5, MAX_RECONNECT_DELAY);
  setTimeout(connectWebSocket, delay);
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


// ─── Extract filename from DOM label above code block (e.g. ChatGPT) ─────────
// ChatGPT renders a filename pill/label as a sibling element above <pre>
// Only looks at the immediately preceding element, max 80 chars

function extractFilenameFromDOM(block) {
  const pre = block.closest('pre');
  if (!pre) return null;

  // Check previous sibling of pre
  const candidates = [];

  // Sibling before <pre>
  const prev = pre.previousElementSibling;
  if (prev) candidates.push(prev.textContent?.trim());

  // Parent's previous sibling (ChatGPT wraps pre in a div)
  const parentPrev = pre.parentElement?.previousElementSibling;
  if (parentPrev) candidates.push(parentPrev.textContent?.trim());

  // Also check for a title/label child inside parent's previous sibling
  if (parentPrev) {
    const inner = parentPrev.querySelector('[class*="title"],[class*="label"],[class*="filename"],[class*="lang"]');
    if (inner) candidates.push(inner.textContent?.trim());
  }

  const filePattern = /^([\w][\w/\\-.]*\.\w{1,10})$/;

  for (const text of candidates) {
    if (!text || text.length > 80 || text.includes('\n')) continue;
    const m = text.match(filePattern);
    if (m && !isBlockedFile(m[1])) return m[1];
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

  // Try filename from code first line, then from DOM label above block
  const filename = extractFilename(raw) || extractFilenameFromDOM(block);
  if (!filename) return;

  sentHashes.add(h);
  // Persist so refresh doesn't re-send
  chrome.storage.local.set({ synapseHashes: [...sentHashes].slice(-500) });

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


function showToast(filename, status, mode) {
  const isOk = status === 'ok';
  const green = '#00ff88';
  const red = '#ff5f5f';
  const accent = isOk ? green : red;

  const modeLabels = { overwrite: 'WRITE', patch: 'PATCH', insert: 'INSERT', delete: 'DELETE' };
  const modeLabel = modeLabels[mode] || 'WRITE';
  const shortName = filename.length > 36 ? '...' + filename.slice(-34) : filename;

  const t = document.createElement('div');
  t.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 2147483647;
    width: 280px;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,.7), 0 0 0 1px ${accent}33;
    transform: translateX(calc(100% + 24px));
    transition: transform .35s cubic-bezier(.22,1,.36,1), opacity .35s;
    opacity: 0;
    font-family: -apple-system, 'Segoe UI', sans-serif;
  `;

  t.innerHTML = `
    <div style="
      background: #0f0f1c;
      border-left: 3px solid ${accent};
      padding: 0;
    ">
      <!-- top bar -->
      <div style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px 6px;
        border-bottom: 1px solid rgba(255,255,255,.06);
      ">
        <div style="display:flex;align-items:center;gap:7px;">
          <span style="
            width: 7px; height: 7px; border-radius: 50%;
            background: ${accent};
            box-shadow: 0 0 6px ${accent};
            flex-shrink: 0;
            display: inline-block;
          "></span>
          <span style="
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 1.2px;
            color: ${accent};
            font-family: 'JetBrains Mono', 'Courier New', monospace;
          ">SYNAPSE</span>
        </div>
        <span style="
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.8px;
          color: ${accent}cc;
          background: ${accent}18;
          border: 1px solid ${accent}33;
          border-radius: 4px;
          padding: 1px 6px;
          font-family: 'JetBrains Mono', 'Courier New', monospace;
        ">${modeLabel}</span>
      </div>
      <!-- filename row -->
      <div style="padding: 8px 12px 10px;">
        <div style="
          font-size: 12px;
          font-family: 'JetBrains Mono', 'Courier New', monospace;
          color: #d0d0e0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          line-height: 1.4;
        ">${isOk ? '✓' : '✗'} &nbsp;${shortName}</div>
        <div style="
          font-size: 9.5px;
          color: #44445a;
          margin-top: 3px;
          font-family: 'JetBrains Mono', 'Courier New', monospace;
        ">${isOk ? 'File written successfully' : 'Write failed'}</div>
      </div>
    </div>
  `;

  document.body.appendChild(t);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      t.style.transform = 'translateX(0)';
      t.style.opacity = '1';
    });
  });

  setTimeout(() => {
    t.style.transform = 'translateX(calc(100% + 24px))';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 400);
  }, 3500);
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
  if (msg.type === 'UPDATE_PORT') {
    wsPort = msg.port;
    reconnectDelay = 0; // force immediate reconnect
    if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); }
    isConnected = false;
    stopHeartbeat();
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false, platform: PLATFORM }).catch(() => {});
    connectWebSocket();
  }
  if (msg.type === 'SET_AUTO_SYNC') { autoSync = msg.enabled; }
  if (msg.type === 'CLEAR_CACHE') { sentHashes.clear(); chrome.storage.local.remove('synapseHashes'); }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

chrome.storage.local.get(['wsPort', 'autoSync', 'synapseHashes'], (r) => {
  if (r.wsPort) wsPort = r.wsPort;
  if (r.autoSync !== undefined) autoSync = r.autoSync;
  // Restore persisted hashes so page refresh doesn't re-send old blocks
  if (Array.isArray(r.synapseHashes)) {
    r.synapseHashes.forEach(h => sentHashes.add(h));
    console.log(`[Synapse] Restored ${sentHashes.size} known hashes`);
  }
  connectWebSocket();
  startObserver();
  console.log(`[Synapse] Initialized on ${PLATFORM}`);
});
