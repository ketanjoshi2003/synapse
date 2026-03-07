// content.js — Synapse v3
// The neural link between AI and your codebase
// Supports: Claude, ChatGPT, Gemini, DeepSeek, Copilot, Grok, Poe, Mistral, HuggingFace

// Guard against double-injection (manifest + executeScript)
if (window.__synapseLoaded) { throw new Error('Synapse already loaded'); }
window.__synapseLoaded = true;

// Only run in the top-level frame, not iframes
if (window.self !== window.top) { throw new Error('Synapse: skipping iframe'); }

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
let reconnectTimer = null;
let projectFiles = []; // File tree from server for smart filename matching

// ─── Platform Detection ──────────────────────────────────────────────────────

function detectPlatform() {
  const host = window.location.hostname;
  if (host.includes('claude.ai')) return 'claude';
  if (host.includes('chat.openai.com') || host.includes('chatgpt.com')) return 'chatgpt';
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
    '[class*="assistant-message"]',
    '[data-is-streaming]',
    '.message-content[data-role="assistant"]'
  ],
  chatgpt: [
    '[data-message-author-role="assistant"]',
    'article[data-testid*="conversation-turn"]',
    '.agent-turn',
    '[class*="assistant-message"]',
    '[class*="markdown"]',
    '.prose'
  ],
  gemini: [
    '.model-response-text',
    '.response-container',
    'message-content[class*="model"]',
    '[class*="response-content"]',
    '[class*="model-response"]',
    '.markdown-content'
  ],
  deepseek: [
    '.ds-markdown--block',
    '[class*="assistant"]',
    '.markdown-body',
    '[class*="bot-message"]'
  ],
  copilot: [
    '[data-content="ai-message"]',
    '.response-message-text',
    '[class*="response"]',
    '[class*="ai-response"]'
  ],
  grok: [
    '[class*="message"][class*="bot"]',
    '[class*="assistant"]',
    '.message-content',
    '[class*="response"]'
  ],
  poe: [
    '[class*="BotMessage"]',
    '[class*="bot_message"]',
    '.Message_botMessage',
    '[class*="response"]'
  ],
  mistral: [
    '[class*="assistant"]',
    '.prose',
    '.message-content',
    '[class*="bot"]'
  ],
  huggingface: [
    '.message.assistant',
    '[class*="assistant"]',
    '[class*="bot"]'
  ],
  unknown: []
};

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try { ws = new WebSocket(`ws://localhost:${wsPort}`); }
  catch (e) { scheduleReconnect(); return; }

  ws.onopen = () => {
    isConnected = true;
    reconnectDelay = 3000;
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: true, platform: PLATFORM }).catch(() => {});
    pendingCode.forEach(d => ws.send(JSON.stringify(d)));
    pendingCode = [];
    startHeartbeat();
    console.log(`[Synapse] ✅ Connected to server (platform: ${PLATFORM})`);
  };

  ws.onclose = () => {
    isConnected = false;
    ws = null;
    stopHeartbeat();
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false, platform: PLATFORM }).catch(() => {});
    scheduleReconnect();
  };

  ws.onerror = () => { /* onclose will fire after this */ };

  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'pong') return;
      if (d.type === 'ACK') {
        chrome.runtime.sendMessage({
          type: 'SYNC_EVENT',
          filename: d.filename,
          status: d.status,
          message: d.message,
          mode: d.mode,
          platform: PLATFORM
        }).catch(() => {});
        console.log(`[Synapse] ACK: ${d.status} → ${d.filename} (${d.message})`);
        showToast(d.filename, d.status, d.mode);
      }
      if (d.type === 'SERVER_INFO') {
        chrome.runtime.sendMessage({ type: 'SERVER_INFO', ...d }).catch(() => {});
      }
      if (d.type === 'FILE_TREE') {
        projectFiles = d.files || [];
        console.log(`[Synapse] 📂 Received file tree: ${projectFiles.length} files`);
      }
    } catch (_) {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = delay === 0 ? 3000 : Math.min(delay * 1.5, MAX_RECONNECT_DELAY);
  const jitter = Math.random() * 1000;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWebSocket(); }, delay + jitter);
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

// ═══════════════════════════════════════════════════════════════════════════════
// FILENAME EXTRACTION — 4 methods chained in priority order
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Method 1: First-line comment ────────────────────────────────────────────
// // path/file.ext | # path/file.ext | -- path/file.ext | /* path/file.ext */

function extractFilenameFromComment(code) {
  const lines = code.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const patterns = [
    /^(?:\/\/|#|--)\s+([\w][\w/\\\-.]*\.\w{1,10})(?:\s.*)?$/,
    /^\/\*\s*([\w][\w/\\\-.]*\.\w{1,10})\s*\*\/$/,
    /^<!--\s*([\w][\w/\\\-.]*\.\w{1,10})\s*-->$/,
    /^;\s*([\w][\w/\\\-.]*\.\w{1,10})$/,
    /^%\s*([\w][\w/\\\-.]*\.\w{1,10})$/,
    /^rem\s+([\w][\w/\\\-.]*\.\w{1,10})$/i,
    /^(?:\/\/|#|--)\s*(?:file|path|filename):\s*([\w][\w/\\\-.]*\.\w{1,10})$/i,
  ];
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    for (const pat of patterns) {
      const m = lines[i].match(pat);
      if (m && !isBlockedFile(m[1])) return m[1];
    }
  }
  return null;
}

// ─── Method 2: Code fence info string ────────────────────────────────────────
// ```typescript:src/app.ts or data-filename attributes

function extractFilenameFromFence(block) {
  const codeEl = block.tagName === 'CODE' ? block : block.querySelector('code');
  if (!codeEl) return null;

  const classes = (codeEl.className || '') + ' ' + (codeEl.parentElement?.className || '');
  const fenceMatch = classes.match(/language-[\w+-]*:([\w][\w/\\\-.]*\.\w{1,10})/);
  if (fenceMatch && !isBlockedFile(fenceMatch[1])) return fenceMatch[1];

  for (const attr of ['data-filename', 'data-file', 'data-path', 'data-file-name']) {
    const val = codeEl.getAttribute(attr) || codeEl.parentElement?.getAttribute(attr);
    if (val && /^[\w][\w/\\\-.]*\.\w{1,10}$/.test(val.trim()) && !isBlockedFile(val.trim())) {
      return val.trim();
    }
  }
  return null;
}

// ─── Method 3: DOM label above code block ────────────────────────────────────
// ChatGPT filename pill, Claude file labels, platform-specific headers

function extractFilenameFromDOM(block) {
  const pre = block.closest('pre');
  if (!pre) return null;

  const candidates = [];
  const prev = pre.previousElementSibling;
  if (prev) candidates.push(prev.textContent?.trim());

  const parentPrev = pre.parentElement?.previousElementSibling;
  if (parentPrev) candidates.push(parentPrev.textContent?.trim());

  // Scan for labeled elements
  for (const el of [prev, parentPrev].filter(Boolean)) {
    const inner = el.querySelector(
      '[class*="title"],[class*="label"],[class*="filename"],[class*="lang"],' +
      '[class*="file"],[class*="name"],[class*="header"]'
    );
    if (inner) candidates.push(inner.textContent?.trim());
  }

  // Grandparent header area
  const grandParent = pre.parentElement?.parentElement;
  if (grandParent) {
    const header = grandParent.querySelector('[class*="header"],[class*="title"],[class*="toolbar"]');
    if (header) candidates.push(header.textContent?.trim());
  }

  // Code block wrapper (Claude-style)
  const wrapper = pre.closest('[class*="code-block"],[class*="codeBlock"],[class*="CodeBlock"]');
  if (wrapper) {
    const label = wrapper.querySelector('[class*="title"],[class*="label"],[class*="filename"],[class*="header"] span');
    if (label) candidates.push(label.textContent?.trim());
  }

  const filePattern = /^([\w][\w/\\\-.]*\.\w{1,10})$/;
  for (const text of candidates) {
    if (!text || text.length > 80 || text.includes('\n')) continue;
    const m = text.match(filePattern);
    if (m && !isBlockedFile(m[1])) return m[1];
    // Handle "Copy  src/app.ts" or "typescript  src/app.ts"
    for (const part of text.split(/\s+/)) {
      const pm = part.match(filePattern);
      if (pm && !isBlockedFile(pm[1])) return pm[1];
    }
  }
  return null;
}

// ─── Method 4: Surrounding text context ──────────────────────────────────────
// Parses AI conversation text around the code block
// "Here's `src/app.ts`:", "Update **server.js**:", "Create file X with:", etc.

function extractFilenameFromContext(block) {
  const pre = block.closest('pre');
  const startEl = pre || block;
  const FILE_RE = /[\w][\w/\\\-.]*\.\w{1,10}/;

  const contextPatterns = [
    /`([\w][\w/\\\-.]*\.\w{1,10})`/,
    /\*\*([\w][\w/\\\-.]*\.\w{1,10})\*\*/,
    /(?:file|path|filename)\s*[:=]\s*`?([\w][\w/\\\-.]*\.\w{1,10})`?/i,
    /(?:create|update|modify|edit|change|write|save|replace|overwrite|add)\s+(?:the\s+)?(?:file\s+)?(?:called\s+|named\s+)?`?([\w][\w/\\\-.]*\.\w{1,10})`?/i,
    /(?:here[''\u2019]?s?|this is|the|your)\s+(?:the\s+)?(?:updated?\s+|modified?\s+|new\s+|complete\s+|full\s+|revised\s+|corrected\s+|fixed\s+)?`?([\w][\w/\\\-.]*\.\w{1,10})`?\s*[:\u2014-]/i,
    /\bin\s+`?([\w][\w/\\\-.]*\.\w{1,10})`?\s*[:.]?\s*$/i,
    /\bfor\s+`?([\w][\w/\\\-.]*\.\w{1,10})`?\s*[:.]?\s*$/i,
    /save\s+(?:this\s+)?(?:as|to)\s+`?([\w][\w/\\\-.]*\.\w{1,10})`?/i,
  ];

  function searchElement(el) {
    if (!el) return null;
    const text = el.textContent?.trim();
    if (!text || text.length > 600 || text.length < 3) return null;
    if (!FILE_RE.test(text)) return null;
    for (const pat of contextPatterns) {
      const m = text.match(pat);
      if (m && !isBlockedFile(m[1])) return m[1];
    }
    return null;
  }

  // Preceding siblings
  let el = startEl.previousElementSibling;
  for (let i = 0; i < 4 && el; i++, el = el.previousElementSibling) {
    const result = searchElement(el);
    if (result) return result;
  }

  // Parent's preceding siblings
  if (startEl.parentElement) {
    el = startEl.parentElement.previousElementSibling;
    for (let i = 0; i < 3 && el; i++, el = el.previousElementSibling) {
      const result = searchElement(el);
      if (result) return result;
    }
  }

  // Grandparent's preceding siblings
  if (startEl.parentElement?.parentElement) {
    el = startEl.parentElement.parentElement.previousElementSibling;
    for (let i = 0; i < 2 && el; i++, el = el.previousElementSibling) {
      const result = searchElement(el);
      if (result) return result;
    }
  }

  return null;
}

// ─── Smart filename resolution against project file tree ──────────────────────

function resolveFilename(rawName) {
  if (!rawName) return null;
  const name = rawName.replace(/\\/g, '/').replace(/^\.?\//, '');

  if (projectFiles.length === 0) return name;
  if (projectFiles.includes(name)) return name;

  // Basename matching
  const basename = name.split('/').pop();
  const matches = projectFiles.filter(f => f.endsWith('/' + basename) || f === basename);
  if (matches.length === 1) return matches[0];

  // Path overlap scoring for ambiguous matches
  if (matches.length > 1) {
    const parts = name.split('/');
    let best = matches[0], bestScore = 0;
    for (const m of matches) {
      const mParts = m.split('/');
      let score = 0;
      for (let i = 1; i <= Math.min(parts.length, mParts.length); i++) {
        if (parts[parts.length - i] === mParts[mParts.length - i]) score++;
        else break;
      }
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  return name; // New file
}

// ─── SEARCH/REPLACE block detection ──────────────────────────────────────────

function parseSearchReplaceBlocks(code) {
  const blocks = [];
  const regex = /<<<<<<<?[ \t]*SEARCH[ \t]*\n([\s\S]*?)\n={5,}\n([\s\S]*?)\n>>>>>>>?[ \t]*REPLACE/g;
  let m;
  while ((m = regex.exec(code)) !== null) {
    blocks.push({ find: m[1], replace: m[2] });
  }
  return blocks;
}

// ─── Detect "...existing code..." markers (partial file update) ──────────────

function hasExistingCodeMarkers(code) {
  return /(?:\/\/|#|--|\/\*)\s*\.{2,}\s*(?:existing|rest|other|remaining|previous|more)\s+(?:code|content|implementation)/i.test(code);
}

// ─── Blocked files ────────────────────────────────────────────────────────────

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
    } catch (_) {}
  }

  if (containers.length === 0) {
    document.querySelectorAll('pre code, pre').forEach(processBlock);
    return;
  }

  containers.forEach(c => c.querySelectorAll('pre code, pre').forEach(processBlock));
}

// ─── Process a single code block ──────────────────────────────────────────────

function processBlock(block) {
  const raw = block.innerText?.trim();
  if (!raw || raw.length < 10) return;

  const h = hash(raw);
  if (sentHashes.has(h)) return;

  // Filename resolution chain (priority order)
  let filename =
    extractFilenameFromFence(block) ||
    extractFilenameFromComment(raw) ||
    extractFilenameFromDOM(block) ||
    extractFilenameFromContext(block);

  if (!filename) return;

  filename = resolveFilename(filename);
  if (!filename) return;

  sentHashes.add(h);
  chrome.storage.local.set({ synapseHashes: [...sentHashes].slice(-500) });

  // Detect SEARCH/REPLACE blocks
  const srBlocks = parseSearchReplaceBlocks(raw);
  if (srBlocks.length > 0) {
    sendToServer({
      type: 'code_block', timestamp: Date.now(),
      language: detectLanguage(block), filename, code: raw,
      mode: 'search_replace', patches: srBlocks,
      platform: PLATFORM, conversationId: getConversationId()
    });
    glow(block);
    console.log(`[Synapse] → SEARCH/REPLACE: ${filename} (${srBlocks.length} blocks)`);
    return;
  }

  // Detect partial update with existing-code markers
  if (hasExistingCodeMarkers(raw)) {
    sendToServer({
      type: 'code_block', timestamp: Date.now(),
      language: detectLanguage(block), filename, code: raw,
      mode: 'smart_patch',
      platform: PLATFORM, conversationId: getConversationId()
    });
    glow(block);
    console.log(`[Synapse] → Smart patch: ${filename}`);
    return;
  }

  // Default: full code block — server decides mode
  sendToServer({
    type: 'code_block', timestamp: Date.now(),
    language: detectLanguage(block), filename, code: raw,
    platform: PLATFORM, conversationId: getConversationId()
  });
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
  const p = window.location.pathname;
  let m = p.match(/\/chat\/([a-zA-Z0-9-]+)/);
  if (m) return m[1];
  m = p.match(/\/c\/([a-zA-Z0-9-]+)/);
  if (m) return m[1];
  m = p.match(/\/app\/([a-zA-Z0-9-]+)/);
  if (m) return m[1];
  m = p.match(/([a-f0-9-]{8,})/);
  if (m) return m[1];
  return 'unknown';
}

// ─── DOM Observer with adaptive streaming detection ───────────────────────────

function startObserver() {
  let scanTimer = null;
  let lastMutationTime = 0;

  const observer = new MutationObserver(() => {
    lastMutationTime = Date.now();
    if (scanTimer) clearTimeout(scanTimer);

    // Adaptive debounce: wait for AI to stop streaming
    scanTimer = setTimeout(() => {
      scanTimer = null;
      extractCodeBlocks();
    }, 1200);
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
    if (pendingCode.length > 100) pendingCode.shift();
  }
}

// ─── UI Feedback ──────────────────────────────────────────────────────────────

function showToast(filename, status, mode) {
  const isOk = status === 'ok';
  const accent = isOk ? '#10b981' : '#ef4444';
  const modeLabels = {
    overwrite: 'WRITE', patch: 'PATCH', insert: 'INSERT', delete: 'DELETE',
    search_replace: 'EDIT', smart_patch: 'SMART EDIT', create: 'CREATE'
  };
  const modeLabel = modeLabels[mode] || 'SYNC';
  const shortName = filename.length > 36 ? '...' + filename.slice(-34) : filename;

  const t = document.createElement('div');
  t.style.cssText = `
    position: fixed; top: 24px; right: 24px; z-index: 2147483647;
    width: 300px; border-radius: 12px; overflow: hidden;
    background: rgba(10,10,10,0.85); backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    box-shadow: 0 16px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08);
    transform: translateX(calc(100% + 32px));
    transition: transform .4s cubic-bezier(0.16,1,0.3,1), opacity .4s;
    opacity: 0; font-family: 'Inter', -apple-system, sans-serif;
  `;
  const escapedName = shortName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  t.innerHTML = `
    <div style="border-left: 4px solid ${accent};">
      <div style="display:flex;align-items:center;justify-content:space-between;
                  padding:12px 16px 10px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${accent};
                       box-shadow:0 0 10px ${accent}66;display:inline-block;"></span>
          <span style="font-size:11px;font-weight:600;letter-spacing:0.5px;color:#f8fafc;">SYNAPSE</span>
        </div>
        <span style="font-size:10px;font-weight:600;letter-spacing:0.5px;color:${accent};
                     background:${accent}1a;border:1px solid ${accent}33;border-radius:6px;
                     padding:2px 8px;font-family:'JetBrains Mono',monospace;">${modeLabel}</span>
      </div>
      <div style="padding:12px 16px 14px;">
        <div style="font-size:13px;font-family:'JetBrains Mono',monospace;color:#f8fafc;
                    font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${escapedName}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:4px;">
          ${isOk ? 'Synced successfully' : 'Sync failed'}</div>
      </div>
    </div>`;

  document.body.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    t.style.transform = 'translateX(0)'; t.style.opacity = '1';
  }));
  setTimeout(() => {
    t.style.transform = 'translateX(calc(100% + 24px))'; t.style.opacity = '0';
    setTimeout(() => t.remove(), 400);
  }, 3500);
}

function glow(block) {
  const pre = block.closest('pre') || block;
  pre.style.outline = '2px solid rgba(16, 185, 129, 0.5)';
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
    reconnectDelay = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }
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
  if (Array.isArray(r.synapseHashes)) {
    r.synapseHashes.forEach(h => sentHashes.add(h));
    console.log(`[Synapse] Restored ${sentHashes.size} known hashes`);
  }
  connectWebSocket();
  startObserver();
  console.log(`[Synapse] Initialized on ${PLATFORM}`);
});
