// content.js — Synapse v3
// The neural link between AI and your codebase
// Supports: Claude, ChatGPT, Gemini, DeepSeek, Copilot, Grok, Poe, Mistral, HuggingFace

// Guard against double-injection and iframes.
(() => {
  if (window.__synapseLoaded || window.self !== window.top) { return; }
  window.__synapseLoaded = true;

  let ws = null;
  let wsPort = 3131;
  let isConnected = false;
  let autoSync = true;
  // Hashes are tracking to avoid duplicate syncs.
  // We persist these in chrome.storage.local so they survive page refreshes.
  let sentHashes = new Set();

  function addSentHash(h) {
    if (sentHashes.has(h)) return;
    sentHashes.add(h);
    const hashArr = Array.from(sentHashes);
    if (hashArr.length > 500) {
      hashArr.splice(0, hashArr.length - 500); // keep last 500
      sentHashes = new Set(hashArr);
    }
    chrome.storage.local.set({ synapseHashes: hashArr });
  }
  let pendingCode = [];
  let reconnectDelay = 2000;
  const MIN_RECONNECT_DELAY = 2000;
  const MAX_RECONNECT_DELAY = 30000;
  let heartbeatInterval = null;
  let reconnectTimer = null;
  let lastConnectAttempt = 0;
  const CONNECT_COOLDOWN = 3000; // Minimum gap between connection attempts
  let projectFiles = []; // File tree from server for smart filename matching
  let isPageVisible = !document.hidden;
  let pageObserver = null;
  let pendingFileCallback = null; // Callback for FILE_CONTENT responses

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
      '.prose',
      '[data-testid="assistant-message"]',
      '.font-claude-message',
      '[class*="AssistantMessage"]',
      '[class*="assistant-message"]',
      '[data-is-streaming]',
      '.message-content[data-role="assistant"]',
      '.grid-cols-1',   // Common layout wrapper in new Claude UI
      '.max-w-3xl'      // Common content constraint wrapper
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
    // Don't connect if page is hidden (background tab)
    if (!isPageVisible) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    // Enforce cooldown to prevent rapid connect/disconnect churn
    const now = Date.now();
    if (now - lastConnectAttempt < CONNECT_COOLDOWN) {
      if (!reconnectTimer) {
        const wait = CONNECT_COOLDOWN - (now - lastConnectAttempt);
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWebSocket(); }, wait);
      }
      return;
    }
    lastConnectAttempt = now;

    // Clean up any lingering socket before creating a new one
    if (ws) {
      try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (_) { }
      ws = null;
    }

    try { ws = new WebSocket(`ws://localhost:${wsPort}`); }
    catch (e) { scheduleReconnect(); return; }

    ws.onopen = () => {
      isConnected = true;
      reconnectDelay = MIN_RECONNECT_DELAY;
      chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: true, platform: PLATFORM }).catch(() => { });
      pendingCode.forEach(d => ws.send(JSON.stringify(d)));
      pendingCode = [];
      startHeartbeat();
      console.log(`[Synapse] Connected to server (platform: ${PLATFORM})`);
    };

    ws.onclose = () => {
      isConnected = false;
      ws = null;
      stopHeartbeat();
      chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false, platform: PLATFORM }).catch(() => { });
      // Only reconnect if page is still visible
      if (isPageVisible) scheduleReconnect();
    };

    ws.onerror = () => { /* onclose will fire after this */ };

    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'pong') return;
        if (d.type === 'CONFIRM_WRITE') {
          showConfirmPopup(d);
          return;
        }
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
        if (d.type === 'FILE_TREE') {
          projectFiles = d.files || [];
          console.log(`[Synapse] Received file tree: ${projectFiles.length} files`);
        }
        if (d.type === 'FILE_CONTENT') {
          if (d.error) {
            showToast(d.filename + ': ' + d.error, 'error', 'context');
          } else if (pendingFileCallback) {
            pendingFileCallback(d.content, d.extension);
            pendingFileCallback = null;
          }
        }
      } catch (_) { }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    if (!isPageVisible) return;

    const delay = reconnectDelay;
    // Exponential backoff with a proper minimum floor
    reconnectDelay = Math.min(delay * 1.5, MAX_RECONNECT_DELAY);
    const jitter = Math.random() * Math.min(delay * 0.3, 2000);
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
      /^[*\s]*([\w][\w/\\\-.]*\.\w{1,10})[*\s]*$/i,
      /(?:(?:target|output)\s+)?(?:file\s*name|file|path|filename)\s*[:=]\s*`?([\w][\w/\\\-.]*\.\w{1,10})`?/i,
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

    // Walk up the DOM tree and check preceding siblings at each level
    let current = startEl;
    for (let depth = 0; depth < 6; depth++) {
      if (!current) break;
      let el = current.previousElementSibling;
      for (let i = 0; i < 4 && el; i++) { // Check up to 4 preceding siblings per level
        const result = searchElement(el);
        if (result) return result;
        el = el.previousElementSibling;
      }
      current = current.parentElement;
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
    const gitRegex = /<<<<<<<?[ \t]*SEARCH[ \t]*\n([\s\S]*?)\n={5,}\n([\s\S]*?)\n>>>>>>>?[ \t]*REPLACE/g;
    let m;
    while ((m = gitRegex.exec(code)) !== null) {
      blocks.push({ find: m[1], replace: m[2] });
    }
    const aiRegex = /(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*Find (?:this|code)[^]*?:\s*(?:-->|\*\/)?\s*\n)([\s\S]*?)(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*Replace (?:with|code)[^]*?:\s*(?:-->|\*\/)?\s*\n)([\s\S]*?)(?=(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*Find (?:this|code)[^]*?:)|$)/gi;
    while ((m = aiRegex.exec(code)) !== null) {
      blocks.push({ find: m[1].replace(/\n$/, ''), replace: m[2].replace(/\n$/, '') });
    }
    return blocks;
  }

  // ─── Detect "...existing code..." markers (partial file update) ──────────────

  function hasExistingCodeMarkers(code) {
    // Explicit markers: // ... existing code, # ... rest of implementation, etc.
    if (/(?:\/\/|#|--|\/\*|\*)\s*\.{2,}\s*(?:existing|rest|other|remaining|previous|more)\s+(?:code|content|implementation|file|logic|of the|unchanged)/i.test(code)) return true;
    // Bare ellipsis on its own line: ..., …, // ..., # ..., /* ... */
    if (/^\s*(?:\/\/|#|--|\/\*\s*)?\s*(?:\.{3,}|…)\s*(?:\*\/)?\s*$/m.test(code)) return true;
    // HTML comment ellipsis: <!-- ... -->
    if (/<!--\s*\.{3,}\s*-->/i.test(code)) return true;
    // Truncation phrases: // (rest remains the same), # unchanged below, etc.
    if (/(?:\/\/|#|--|\/\*|\*)\s*(?:\(?\s*(?:rest|remaining|unchanged|same as|keep|stays?|no changes?|untouched|omitted|truncated|snip|collapsed|hidden|abbreviated))/i.test(code)) return true;
    return false;
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
    let pres = [];

    // Find the first valid selector that actually contains code blocks
    for (const sel of selectors) {
      try {
        const containers = Array.from(document.querySelectorAll(sel));
        const foundPres = containers.flatMap(c => Array.from(c.querySelectorAll('pre')));
        if (foundPres.length > 0) {
          pres = Array.from(new Set(foundPres)); // remove duplicates just in case
          break;
        }
      } catch (_) { }
    }

    if (pres.length === 0) return;

    const skip = new Set();

    for (let i = 0; i < pres.length; i++) {
      if (skip.has(pres[i])) continue;

      let pre1 = pres[i];

      // Try pairing with the next block for ChatGPT's "Replace / with" diff pattern
      if (i + 1 < pres.length) {
        let pre2 = pres[i + 1];
        try {
          let range = document.createRange();
          range.setStartAfter(pre1);
          range.setEndBefore(pre2);
          let between = range.toString().trim().toLowerCase();

          // Check text directly above the first block
          let prevElText = (pre1.previousElementSibling && pre1.previousElementSibling.textContent ? pre1.previousElementSibling.textContent : '').trim().toLowerCase();
          let prevNodeText = (pre1.previousSibling && pre1.previousSibling.textContent ? pre1.previousSibling.textContent : '').trim().toLowerCase();

          if (between === 'with' || between === 'with:') {
            if (prevElText.endsWith('replace:') || prevElText.endsWith('replace') ||
              prevNodeText.endsWith('replace:') || prevNodeText.endsWith('replace')) {

              processSearchReplacePair(pre1, pre2);
              skip.add(pre1);
              skip.add(pre2);
              continue;
            }
          }
        } catch (e) { }
      }

      processBlock(pres[i].querySelector('code') || pres[i]);
    }
  }

  function processSearchReplacePair(pre1, pre2) {
    let raw1 = (pre1.querySelector('code') || pre1).innerText?.trim();
    let raw2 = (pre2.querySelector('code') || pre2).innerText?.trim();
    if (!raw1 || !raw2) return;

    const stripLang = (codeStr) => {
      const lines = codeStr.split('\n');
      if (/^(html|css|javascript|typescript|python|java|ruby|php|go|rust|c|cpp|c\+\+|c#|csharp|swift|kotlin|scala|r|sql|shell|bash|powershell|markdown|json|xml|yaml|toml|dockerfile|makefile|plaintext|plain text|text|jsx|tsx|js|ts|py|rb|rs|cs|sh|zsh|vue|svelte|dart|lua|perl|elixir|clojure|haskell|ocaml|zig|nim|groovy|assembly|asm|coffeescript|scss|sass|less|graphql|proto|protobuf|matlab|fortran|cobol|ada|vhdl|verilog|tcl|cmake|csv|ini|cfg|conf|env|bat|ps1|fish|diff|patch|http|nginx)$/i.test(lines[0]?.trim())) {
        lines.shift();
        return lines.join('\n').trim();
      }
      return codeStr;
    };

    raw1 = stripLang(raw1);
    raw2 = stripLang(raw2);

    const h = hash(raw1 + raw2);
    if (sentHashes.has(h)) return;

    let filename = extractFilenameFromFence(pre1) || extractFilenameFromComment(raw1) || extractFilenameFromDOM(pre1) || extractFilenameFromContext(pre1);

    // Explicitly check for ChatGPT "Canvas" UI which renders files as "1 index.html" before the replace blocks
    if (!filename) {
      let msg = pre1.closest('[data-message-author-role="assistant"], .agent-turn, article');
      if (msg) {
        let walker = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
          const txt = node.textContent.trim();
          const match = txt.match(/^1\s+([\w][\w/\\\-.]*\.\w{1,10})$/) || txt.match(/^([\w][\w/\\\-.]*\.\w{1,10})$/);
          if (match && pre1.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) {
            filename = match[1];
          }
        }
      }
    }

    if (!filename) return;
    filename = resolveFilename(filename);
    if (!filename) return;

    addSentHash(h);

    sendToServer({
      type: 'code_block', timestamp: Date.now(),
      language: detectLanguage(pre1), filename, code: raw2,
      mode: 'search_replace', patches: [{ find: raw1, replace: raw2 }],
      platform: PLATFORM, conversationId: getConversationId()
    });

    glow(pre1); glow(pre2);
    console.log(`[Synapse] → SEARCH/REPLACE Pair: ${filename}`);
  }

  // ─── Process a single code block ──────────────────────────────────────────────

  function processBlock(block) {
    let raw = block.innerText?.trim();
    if (!raw || raw.length < 10) return;

    // Strip bare language label from first line — ChatGPT/Claude render the
    // code-block header (e.g. "HTML", "JavaScript") as visible text that
    // innerText picks up. This must NOT be written to the file.
    const lines = raw.split('\n');
    if (/^(html|css|javascript|typescript|python|java|ruby|php|go|rust|c|cpp|c\+\+|c#|csharp|swift|kotlin|scala|r|sql|shell|bash|powershell|markdown|json|xml|yaml|toml|dockerfile|makefile|plaintext|plain text|text|jsx|tsx|js|ts|py|rb|rs|cs|sh|zsh|vue|svelte|dart|lua|perl|elixir|clojure|haskell|ocaml|zig|nim|groovy|assembly|asm|coffeescript|scss|sass|less|graphql|proto|protobuf|matlab|fortran|cobol|ada|vhdl|verilog|tcl|cmake|csv|ini|cfg|conf|env|bat|ps1|fish|diff|patch|http|nginx)$/i.test(lines[0]?.trim())) {
      lines.shift();
      raw = lines.join('\n').trim();
      if (!raw || raw.length < 10) return;
    }

    const h = hash(raw);
    if (sentHashes.has(h)) {
      console.log(`[Synapse] ⏭️ Skipped (already sent): hash=${h}, preview="${raw.slice(0, 60)}..."`);
      return;
    }

    // Filename resolution chain (priority order)
    const fnFence = extractFilenameFromFence(block);
    const fnComment = extractFilenameFromComment(raw);
    const fnDOM = extractFilenameFromDOM(block);
    const fnContext = extractFilenameFromContext(block);
    let filename = fnFence || fnComment || fnDOM || fnContext;

    // Fallback: inherit filename from a recently processed block in the same message
    if (!filename) {
      const msg = block.closest('pre')?.closest('[data-testid], article, .agent-turn, [class*="message"], .prose, [class*="response"]');
      if (msg && msg.__synapseLastFile) {
        filename = msg.__synapseLastFile;
        console.log(`[Synapse] 🔗 Inherited filename from same message: ${filename}`);
      }
    }

    console.log(`[Synapse] 🔍 Block: "${raw.slice(0, 80)}..." | Fence=${fnFence} Comment=${fnComment} DOM=${fnDOM} Context=${fnContext}`);

    if (!filename) {
      console.log(`[Synapse] ❌ No filename found, skipping block`);
      return;
    }

    filename = resolveFilename(filename);
    if (!filename) return;

    // Store filename on the message container so sibling blocks can inherit it
    const msgContainer = block.closest('pre')?.closest('[data-testid], article, .agent-turn, [class*="message"], .prose, [class*="response"]');
    if (msgContainer) msgContainer.__synapseLastFile = filename;



    addSentHash(h);

    // Detect SEARCH/REPLACE blocks
    const srBlocks = parseSearchReplaceBlocks(raw);
    console.log(`[Synapse] 🔎 SR blocks found: ${srBlocks.length} for ${filename}`);
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

  // Container for all Synapse UI elements — outside the observer's scope
  let _synapseDomOp = false; // flag to skip observer during our own DOM changes

  function startObserver() {
    let scanTimer = null;

    pageObserver = new MutationObserver(() => {
      // Skip mutations triggered by Synapse's own DOM operations (toasts, popups)
      if (_synapseDomOp) return;

      if (scanTimer) clearTimeout(scanTimer);

      // Adaptive debounce: wait for AI to stop streaming
      scanTimer = setTimeout(() => {
        scanTimer = null;
        extractCodeBlocks();
      }, 2000);
    });

    // Exclude characterData to cut noise from ChatGPT's live typing updates.
    // childList + subtree is enough to detect new code blocks being added.
    pageObserver.observe(document.body, { childList: true, subtree: true, characterData: false });
    console.log(`[Synapse] Observer active (${PLATFORM})`);
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
      search_replace: 'EDIT', smart_patch: 'SMART EDIT', create: 'CREATE',
      snippet_merge: 'MERGE', context: 'FILE CONTEXT'
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
    const escapedName = shortName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

    _synapseDomOp = true;
    document.documentElement.appendChild(t);
    _synapseDomOp = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      t.style.transform = 'translateX(0)'; t.style.opacity = '1';
    }));
    setTimeout(() => {
      t.style.transform = 'translateX(calc(100% + 24px))'; t.style.opacity = '0';
      _synapseDomOp = true;
      setTimeout(() => { t.remove(); _synapseDomOp = false; }, 400);
    }, 3500);
  }

  // ─── Confirmation Popup ───────────────────────────────────────────────────────

  // Queue of pending confirmations when multiple come in rapid succession
  const confirmQueue = [];
  let confirmVisible = false;

  function showConfirmPopup(data) {
    // Add timestamp for staleness tracking
    data._receivedAt = Date.now();
    confirmQueue.push(data);
    if (!confirmVisible) processNextConfirm();
  }

  function processNextConfirm() {
    // Skip stale items in the queue (if they arrived too long ago, the server
    // has already timed out the confirmation — no point showing them)
    const STALE_THRESHOLD = 50000; // 50s — server timeout is 60s
    while (confirmQueue.length > 0) {
      const next = confirmQueue[0];
      if (next._receivedAt && (Date.now() - next._receivedAt) > STALE_THRESHOLD) {
        confirmQueue.shift();
        // Auto-reject stale items so server cleans up
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'confirm_response', confirmId: next.confirmId, approved: false }));
        }
        console.log(`[Synapse] Auto-rejected stale confirmation: ${next.filename}`);
        continue;
      }
      break;
    }
    if (confirmQueue.length === 0) { confirmVisible = false; return; }
    confirmVisible = true;
    const data = confirmQueue.shift();
    renderConfirmPopup(data);
  }

  function renderConfirmPopup({ confirmId, filename, mode, preview, existing, incoming }) {
    // Remove any existing confirm popup
    _synapseDomOp = true;
    const existingPopup = document.getElementById('__synapse-confirm');
    if (existingPopup) existingPopup.remove();
    _synapseDomOp = false;

    const modeColors = {
      overwrite: '#f59e0b', patch: '#8b5cf6', search_replace: '#3b82f6',
      smart_patch: '#a78bfa', insert: '#06b6d4', delete: '#ef4444', create: '#10b981',
      snippet_merge: '#10b981'
    };
    const accent = modeColors[mode] || '#8b5cf6';
    const modeLabel = (mode || 'write').toUpperCase().replace('_', ' ');
    const shortName = filename.length > 50 ? '...' + filename.slice(-48) : filename;

    const overlay = document.createElement('div');
    overlay.id = '__synapse-confirm';
    overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 2147483647;
    background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    display: flex; align-items: flex-start; justify-content: center; padding-top: 80px;
    opacity: 0; transition: opacity .2s ease;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  `;

    const escapedName = shortName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapedPreview = (preview || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const queueCount = confirmQueue.length;
    const queueBadge = queueCount > 0
      ? `<span style="font-size:10px;color:#94a3b8;margin-left:8px;">(+${queueCount} pending)</span>`
      : '';

    // Build batch button row if there are queued items
    const batchBtns = queueCount > 0
      ? `<div style="padding:0 20px 10px; display:flex; gap:8px;">
        <button id="__synapse-approve-all" style="
          flex:1; padding:7px 10px; border:1px solid rgba(16,185,129,0.3); border-radius:8px;
          background:rgba(16,185,129,0.1); color:#10b981; font-size:11px; font-weight:600;
          cursor:pointer; transition:all .15s ease; font-family:inherit;
        ">Approve All (${queueCount + 1})</button>
        <button id="__synapse-reject-all" style="
          flex:1; padding:7px 10px; border:1px solid rgba(239,68,68,0.3); border-radius:8px;
          background:rgba(239,68,68,0.1); color:#ef4444; font-size:11px; font-weight:600;
          cursor:pointer; transition:all .15s ease; font-family:inherit;
        ">Reject All (${queueCount + 1})</button>
       </div>`
      : '';

    // Build diff preview if we have both existing and incoming content
    let diffHtml = '';
    if (existing || incoming) {
      const escHtml = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (existing && incoming && mode === 'overwrite') {
        // Show a simple side-by-side: what's there vs what's coming, ONLY for full overwrites
        const existLines = existing.split('\n').slice(0, 12);
        const incomLines = incoming.split('\n').slice(0, 12);
        const existPreview = existLines.map(l => `<div style="color:#f87171;opacity:0.8;">- ${escHtml(l)}</div>`).join('');
        const incomPreview = incomLines.map(l => `<div style="color:#4ade80;">+ ${escHtml(l)}</div>`).join('');
        const existMore = existing.split('\n').length > 12 ? `<div style="color:#64748b;">  ... ${existing.split('\n').length - 12} more lines</div>` : '';
        const incomMore = incoming.split('\n').length > 12 ? `<div style="color:#64748b;">  ... ${incoming.split('\n').length - 12} more lines</div>` : '';
        diffHtml = `
        <div style="padding:0 20px 12px;">
          <div style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Preview</div>
          <div style="background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:8px 10px;
                      font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.5;max-height:180px;overflow-y:auto;
                      scrollbar-width:none;">
            ${existPreview}${existMore}
            <div style="border-top:1px solid rgba(255,255,255,0.06);margin:6px 0;"></div>
            ${incomPreview}${incomMore}
          </div>
        </div>`;
      } else if (incoming) {
        // Snippet merge, search_replace, patch, or create — just show the incoming snippet code cleanly
        const incomLines = incoming.split('\n').slice(0, 15);
        const incomPreview = incomLines.map(l => `<div style="color:#e2e8f0;">${escHtml(l)}</div>`).join('');
        const incomMore = incoming.split('\n').length > 15 ? `<div style="color:#64748b;">  ... ${incoming.split('\n').length - 15} more lines</div>` : '';
        const title = mode === 'snippet_merge' ? 'Incoming Merge Snippet' : (mode === 'create' ? 'New File Content' : 'Snippet Preview');

        diffHtml = `
        <div style="padding:0 20px 12px;">
          <div style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">${title}</div>
          <div style="background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:8px 10px;
                      font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.5;max-height:180px;overflow-y:auto;
                      scrollbar-width:none;">
            ${incomPreview}${incomMore}
          </div>
        </div>`;
      }
    }

    overlay.innerHTML = `
    <div style="
      width: 380px; border-radius: 16px; overflow: hidden;
      background: rgba(15,15,15,0.95); backdrop-filter: blur(20px);
      box-shadow: 0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08), 0 0 40px ${accent}22;
      transform: translateY(-10px) scale(0.97); transition: transform .25s cubic-bezier(0.16,1,0.3,1);
    ">
      <div style="padding:16px 20px 12px; border-bottom:1px solid rgba(255,255,255,0.06);
                  display:flex; align-items:center; justify-content:space-between;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${accent};
                       box-shadow:0 0 10px ${accent}66;display:inline-block;"></span>
          <span style="font-size:12px;font-weight:600;letter-spacing:0.5px;color:#f8fafc;">CONFIRM WRITE</span>
          ${queueBadge}
        </div>
        <span style="font-size:10px;font-weight:600;letter-spacing:0.5px;color:${accent};
                     background:${accent}1a;border:1px solid ${accent}33;border-radius:6px;
                     padding:2px 8px;font-family:'JetBrains Mono',monospace;">${modeLabel}</span>
      </div>

      <div style="padding:16px 20px;">
        <div style="font-size:14px;font-family:'JetBrains Mono',monospace;color:#f8fafc;
                    font-weight:500;word-break:break-all;line-height:1.4;">
          ${escapedName}
        </div>
        <div style="font-size:12px;color:#94a3b8;margin-top:8px;line-height:1.4;">
          ${escapedPreview}
        </div>
      </div>

      ${diffHtml}

      <div style="padding:12px 20px 16px; display:flex; gap:10px;">
        <button id="__synapse-reject" style="
          flex:1; padding:10px 16px; border:1px solid rgba(255,255,255,0.12); border-radius:10px;
          background:rgba(255,255,255,0.06); color:#f8fafc; font-size:13px; font-weight:500;
          cursor:pointer; transition:all .15s ease; font-family:inherit;
        ">Reject</button>
        <button id="__synapse-approve" style="
          flex:1; padding:10px 16px; border:none; border-radius:10px;
          background:#f8fafc; color:#0a0a0a; font-size:13px; font-weight:600;
          cursor:pointer; transition:all .15s ease; font-family:inherit;
          box-shadow: 0 4px 14px rgba(255,255,255,0.15);
        ">Approve</button>
      </div>

      ${batchBtns}

      <div style="padding:0 20px 12px; text-align:center;">
        <span style="font-size:10px;color:#64748b;">Press Enter to approve, Esc to reject</span>
      </div>
    </div>
  `;

    _synapseDomOp = true;
    document.documentElement.appendChild(overlay);
    _synapseDomOp = false;

    // Animate in
    requestAnimationFrame(() => requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      const card = overlay.firstElementChild;
      if (card) card.style.transform = 'translateY(0) scale(1)';
    }));

    let responded = false;
    function respond(approved) {
      if (responded) return;
      responded = true;
      document.removeEventListener('keydown', onKey, true);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'confirm_response', confirmId, approved }));
      }
      // Animate out
      overlay.style.opacity = '0';
      const card = overlay.firstElementChild;
      if (card) card.style.transform = 'translateY(-10px) scale(0.97)';
      setTimeout(() => {
        _synapseDomOp = true;
        overlay.remove();
        _synapseDomOp = false;
        processNextConfirm();
      }, 200);
    }

    overlay.querySelector('#__synapse-approve').addEventListener('click', () => respond(true));
    overlay.querySelector('#__synapse-reject').addEventListener('click', () => respond(false));

    // Batch buttons — approve/reject all queued confirmations at once
    const approveAllBtn = overlay.querySelector('#__synapse-approve-all');
    const rejectAllBtn = overlay.querySelector('#__synapse-reject-all');
    if (approveAllBtn) {
      approveAllBtn.addEventListener('click', () => {
        // Approve current, then flush the entire queue as approved
        const queueSnapshot = [...confirmQueue];
        confirmQueue.length = 0;
        respond(true);
        for (const item of queueSnapshot) {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'confirm_response', confirmId: item.confirmId, approved: true }));
          }
        }
      });
    }
    if (rejectAllBtn) {
      rejectAllBtn.addEventListener('click', () => {
        const queueSnapshot = [...confirmQueue];
        confirmQueue.length = 0;
        respond(false);
        for (const item of queueSnapshot) {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'confirm_response', confirmId: item.confirmId, approved: false }));
          }
        }
      });
    }

    // Keyboard shortcuts
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); respond(true); }
      if (e.key === 'Escape') { e.preventDefault(); respond(false); }
    }
    document.addEventListener('keydown', onKey, true);

    // Click on backdrop to reject
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) respond(false);
    });

    // Auto-timeout after 55 seconds (server timeout is 60s)
    setTimeout(() => {
      if (document.getElementById('__synapse-confirm') === overlay) {
        respond(false);
      }
    }, 55000);
  }

  // ─── Visual Feedback ──────────────────────────────────────────────────────────

  function glow(block) {
    const pre = block.closest('pre') || block;
    pre.style.outline = '2px solid rgba(16, 185, 129, 0.5)';
    pre.style.outlineOffset = '2px';
    pre.style.transition = 'outline .3s, outline-offset .3s';
    setTimeout(() => { pre.style.outline = 'none'; pre.style.outlineOffset = '0'; }, 2500);
  }

  // ─── File Context Injection ───────────────────────────────────────────────────
  // Floating button + file picker to share file contents with the AI

  const CHAT_INPUT_SELECTORS = {
    claude: ['div.ProseMirror[contenteditable="true"]', '[contenteditable="true"]'],
    chatgpt: ['#prompt-textarea', 'textarea[data-id="root"]', '[contenteditable="true"].ProseMirror'],
    gemini: ['[contenteditable="true"]', 'rich-textarea [contenteditable]', '.ql-editor'],
    deepseek: ['textarea', '[contenteditable="true"]'],
    copilot: ['textarea', '[contenteditable="true"]'],
    grok: ['textarea', '[contenteditable="true"]'],
    poe: ['textarea', '[contenteditable="true"]'],
    mistral: ['textarea', '[contenteditable="true"]'],
    huggingface: ['textarea', '[contenteditable="true"]'],
    unknown: ['textarea', '[contenteditable="true"]']
  };

  let filePickerVisible = false;

  function createFloatingButton() {
    const btn = document.createElement('div');
    btn.id = '__synapse-fab';
    btn.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 2147483646;
    width: 44px; height: 44px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: all .2s cubic-bezier(0.16,1,0.3,1);
    box-shadow: 0 0px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
  `;
    btn.innerHTML = `<img src="${chrome.runtime.getURL('icons/icon512.png')}" style="width: 100%; height: 100%; border-radius: 50%; pointer-events: none;">`;
    btn.title = 'Synapse: Share file with AI (Ctrl+Shift+F)';

    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.08) translateY(-2px)';
      btn.style.boxShadow = '0 0px 24px rgba(16,185,129,0.35), 0 0 0 1px rgba(16,185,129,0.3)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1) translateY(0)';
      btn.style.boxShadow = '0 0px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)';
    });
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }).catch(() => {
        // Fallback if openPopup not supported: open the extension options
      });
    });

    _synapseDomOp = true;
    document.documentElement.appendChild(btn);
    _synapseDomOp = false;
  }

  function openFilePicker() {
    if (filePickerVisible) return;
    if (!isConnected) { showToast('Not connected', 'error', 'context'); return; }
    filePickerVisible = true;

    const overlay = document.createElement('div');
    overlay.id = '__synapse-filepicker';
    overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 2147483647;
    background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    display: flex; align-items: flex-start; justify-content: center; padding-top: 60px;
    opacity: 0; transition: opacity .2s ease;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  `;

    const fileListHtml = projectFiles.slice(0, 200).map(f => {
      const short = f.length > 55 ? '...' + f.slice(-53) : f;
      const esc = short.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const full = f.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<div class="__synapse-fp-item" data-file="${full}" style="
      padding:6px 12px; cursor:pointer; font-size:12px; color:#e2e8f0;
      font-family:'JetBrains Mono',monospace; border-radius:6px;
      transition: background .1s; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    ">${esc}</div>`;
    }).join('');

    overlay.innerHTML = `
    <div style="
      width: 420px; max-height: 480px; border-radius: 16px; overflow: hidden;
      background: rgba(15,15,15,0.95); backdrop-filter: blur(20px);
      box-shadow: 0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08);
      display: flex; flex-direction: column;
      transform: translateY(-10px) scale(0.97); transition: transform .25s cubic-bezier(0.16,1,0.3,1);
    ">
      <div style="padding:16px 20px 12px; border-bottom:1px solid rgba(255,255,255,0.06);
                  display:flex; align-items:center; gap:8px;">
        <span style="width:8px;height:8px;border-radius:50%;background:#10b981;
                     box-shadow:0 0 10px rgba(16,185,129,0.4);display:inline-block;"></span>
        <span style="font-size:12px;font-weight:600;letter-spacing:0.5px;color:#f8fafc;">SHARE FILE WITH AI</span>
        <span style="margin-left:auto;font-size:10px;color:#64748b;">${projectFiles.length} files</span>
      </div>
      <div style="padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.06);">
        <input id="__synapse-fp-search" type="text" placeholder="Search files..." style="
          width:100%; padding:8px 12px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.08);
          border-radius:8px; color:#f8fafc; font-family:'JetBrains Mono',monospace; font-size:12px;
          outline:none; transition: border-color .2s;
        " />
      </div>
      <div id="__synapse-fp-list" style="flex:1; overflow-y:auto; padding:4px 6px; max-height:340px; scrollbar-width:none;">
        ${fileListHtml || '<div style="padding:20px;text-align:center;color:#64748b;font-size:12px;">No files found</div>'}
      </div>
      <div style="padding:8px 14px; border-top:1px solid rgba(255,255,255,0.06); text-align:center;">
        <span style="font-size:10px;color:#64748b;">Click file to inject into chat &middot; Esc to close</span>
      </div>
    </div>
  `;

    _synapseDomOp = true;
    document.documentElement.appendChild(overlay);
    _synapseDomOp = false;

    // Animate in
    requestAnimationFrame(() => requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      const card = overlay.firstElementChild;
      if (card) card.style.transform = 'translateY(0) scale(1)';
      document.getElementById('__synapse-fp-search')?.focus();
    }));

    // Search filtering
    const searchInput = document.getElementById('__synapse-fp-search');
    const listContainer = document.getElementById('__synapse-fp-list');
    searchInput?.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      const items = listContainer.querySelectorAll('.__synapse-fp-item');
      items.forEach(item => {
        const file = item.getAttribute('data-file') || '';
        item.style.display = file.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    // Item hover effect
    listContainer?.addEventListener('mouseover', (e) => {
      const item = e.target.closest('.__synapse-fp-item');
      if (item) item.style.background = 'rgba(16,185,129,0.1)';
    });
    listContainer?.addEventListener('mouseout', (e) => {
      const item = e.target.closest('.__synapse-fp-item');
      if (item) item.style.background = '';
    });

    // Item click — request file content
    listContainer?.addEventListener('click', (e) => {
      const item = e.target.closest('.__synapse-fp-item');
      if (!item) return;
      const file = item.getAttribute('data-file');
      if (!file) return;

      // Request file content from server
      pendingFileCallback = (content, ext) => {
        injectFileIntoChat(file, content, ext);
      };
      ws.send(JSON.stringify({ type: 'request_file_content', filename: file }));
      closePicker();
    });

    function closePicker() {
      filePickerVisible = false;
      overlay.style.opacity = '0';
      const card = overlay.firstElementChild;
      if (card) card.style.transform = 'translateY(-10px) scale(0.97)';
      setTimeout(() => {
        _synapseDomOp = true;
        overlay.remove();
        _synapseDomOp = false;
      }, 200);
      document.removeEventListener('keydown', pickerKey, true);
    }

    function pickerKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
    }
    document.addEventListener('keydown', pickerKey, true);

    // Click backdrop to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePicker();
    });
  }

  function injectFileIntoChat(filename, content, ext) {
    const codeBlock = '```' + (ext || '') + '\n// ' + filename + '\n' + content + '\n```';

    // Try to find the chat input for the current platform
    const selectors = CHAT_INPUT_SELECTORS[PLATFORM] || CHAT_INPUT_SELECTORS.unknown;
    let input = null;
    for (const sel of selectors) {
      input = document.querySelector(sel);
      if (input) break;
    }

    let injected = false;
    if (input) {
      if (input.tagName === 'TEXTAREA') {
        // Standard textarea — insert at cursor or append
        const start = input.selectionStart || input.value.length;
        const before = input.value.substring(0, start);
        const after = input.value.substring(input.selectionEnd || start);
        const prefix = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
        input.value = before + prefix + codeBlock + '\n' + after;
        input.selectionStart = input.selectionEnd = before.length + prefix.length + codeBlock.length + 1;
        // Trigger React's change detection
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.focus();
        injected = true;
      } else if (input.contentEditable === 'true') {
        // ContentEditable (Claude, ChatGPT, etc.)
        input.focus();
        // Use execCommand for React-compatible insertion
        const prefix = input.textContent.length > 0 ? '\n' : '';
        document.execCommand('insertText', false, prefix + codeBlock + '\n');
        injected = true;
      }
    }

    if (!injected) {
      // Fallback: copy to clipboard
      navigator.clipboard.writeText(codeBlock).then(() => {
        showToast(filename, 'ok', 'context');
        console.log(`[Synapse] File copied to clipboard: ${filename}`);
      }).catch(() => {
        console.log(`[Synapse] Failed to copy file to clipboard: ${filename}`);
      });
      showToast(filename + ' (copied to clipboard)', 'ok', 'context');
      return;
    }

    showToast(filename, 'ok', 'context');
    console.log(`[Synapse] Injected file context: ${filename} (${content.split('\n').length} lines)`);
  }

  // Handle FILE_CONTENT responses in ws.onmessage (already handled below)

  // ─── Keyboard shortcut: Ctrl+Shift+F ─────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }).catch(() => { });
    }
  }, true);

  // ─── Message handler ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ connected: isConnected, platform: PLATFORM, autoSync, queueSize: pendingCode.length });
      return true;
    }
    if (msg.type === 'SCAN_NOW') { extractCodeBlocks(); }
    if (msg.type === 'GET_FILE_TREE') {
      sendResponse({ files: projectFiles, connected: isConnected });
      return true;
    }
    if (msg.type === 'INJECT_FILE') {
      const filename = msg.filename;
      if (!filename) { sendResponse({ error: 'No filename' }); return; }
      if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) {
        sendResponse({ error: 'Not connected to server' }); return;
      }
      // Request file content from server, then inject into chat when it arrives
      pendingFileCallback = (content, ext) => {
        injectFileIntoChat(filename, content, ext);
      };
      ws.send(JSON.stringify({ type: 'request_file_content', filename }));
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'UPDATE_PORT') {
      wsPort = msg.port;
      reconnectDelay = MIN_RECONNECT_DELAY;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }
      isConnected = false;
      stopHeartbeat();
      chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false, platform: PLATFORM }).catch(() => { });
      connectWebSocket();
    }
    if (msg.type === 'SET_AUTO_SYNC') { autoSync = msg.enabled; }
    if (msg.type === 'SET_CONFIG') {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_config', dryRun: msg.dryRun, gitBackup: msg.gitBackup }));
      }
    }
    if (msg.type === 'CLEAR_CACHE') { sentHashes.clear(); console.log('[Synapse] Hash cache cleared'); }
  });

  // ─── Page Visibility & Cleanup ─────────────────────────────────────────────

  document.addEventListener('visibilitychange', () => {
    isPageVisible = !document.hidden;
    if (isPageVisible) {
      // Tab became visible — reconnect if needed
      if (!isConnected && !reconnectTimer) {
        reconnectDelay = MIN_RECONNECT_DELAY;
        connectWebSocket();
      }
    } else {
      // Tab hidden — cancel pending reconnect to avoid background connection storms
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    // Disconnect observer first to prevent DOM teardown from triggering scans
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch (_) { }
      ws = null;
    }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────────

  chrome.storage.local.get(['wsPort', 'autoSync', 'synapseHashes'], (r) => {
    if (r.wsPort) wsPort = r.wsPort;
    if (r.autoSync !== undefined) autoSync = r.autoSync;
    if (r.synapseHashes) sentHashes = new Set(r.synapseHashes);
    // Hashes are now restored per-session unless explicitly cleared via the popup
    connectWebSocket();
    console.log(`[Synapse] Init on ${PLATFORM}`);

    // Delay DOM injections slightly to allow ChatGPT/React to finish hydrating.
    // Injecting nodes during hydration causes fatal React mismatches (stuck loading).
    setTimeout(() => {
      startObserver();
      createFloatingButton();
      console.log(`[Synapse] UI and Observer active`);
    }, 1500);
  });

})(); // end IIFE
