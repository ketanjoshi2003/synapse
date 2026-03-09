// server.js — Synapse v3
// Run: node server.js --output C:\path\to\your\project
// Options: --port 3131  --git  --dry-run

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── CLI Args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
function hasFlag(name) { return args.includes(name); }

const PORT = parseInt(getArg('--port', process.env.PORT || '3131'));
let OUTPUT_DIR = path.resolve(getArg('--output', process.cwd()));
let GIT_BACKUP = hasFlag('--git');
let DRY_RUN = hasFlag('--dry-run');

// Directories/patterns to ignore when building file tree
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  '.cache', '.vscode', '.idea', '__pycache__', '.pytest_cache',
  'coverage', '.turbo', '.svelte-kit', 'vendor', 'target', 'bin', 'obj'
]);

const IGNORE_EXTENSIONS = new Set([
  '.map', '.lock', '.log', '.ico', '.png', '.jpg', '.jpeg', '.gif',
  '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.webm',
  '.webp', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib'
]);

// ─── State ────────────────────────────────────────────────────────────────────

const history = [];
const MAX_HISTORY = 200;
let totalSynced = 0;
let totalErrors = 0;

// Pending confirmations: Map<confirmId, { data, ws, mode, filename, timeout }>
const pendingConfirmations = new Map();
let confirmIdCounter = 0;
const CONFIRM_TIMEOUT_MS = 60000; // 1 minute timeout for pending confirmations

// Per-filename dedup: prevent multiple confirmations for the same file in quick succession
const recentConfirmFiles = new Map(); // filename → timestamp
const CONFIRM_FILE_DEDUP_WINDOW = 10000; // 10 seconds

// Periodically clean up stale entries from the dedup map (every 30s)
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentConfirmFiles) {
    if (now - ts > CONFIRM_FILE_DEDUP_WINDOW) recentConfirmFiles.delete(key);
  }
}, 30000);

// ─── Banner ───────────────────────────────────────────────────────────────────

console.log(`
\x1b[36m╔════════════════════════════════════════════════════╗
║  \x1b[32m▐█▌\x1b[36m                                               ║
║  \x1b[32m ██\x1b[36m    \x1b[1;37mSynapse\x1b[0;36m  \x1b[2;37mv3.0  -  Server\x1b[0;36m                   ║
║  \x1b[32m▐█▌\x1b[36m                                               ║
╠════════════════════════════════════════════════════╣\x1b[0m
\x1b[37m║  WebSocket Port  :  \x1b[33m${PORT.toString().padEnd(31)}\x1b[37m║
║  Output Dir      :  \x1b[33m${OUTPUT_DIR.length > 31 ? '...' + OUTPUT_DIR.slice(-28) : OUTPUT_DIR.padEnd(31)}\x1b[37m║
║  Git Backup      :  \x1b[33m${(GIT_BACKUP ? 'ON' : 'OFF').padEnd(31)}\x1b[37m║
║  Dry-Run Mode    :  \x1b[33m${(DRY_RUN ? 'ON' : 'OFF').padEnd(31)}\x1b[37m║
\x1b[36m╚════════════════════════════════════════════════════╝\x1b[0m
`);

if (!fs.existsSync(OUTPUT_DIR)) {
  console.error(`\x1b[31m❌ Output directory does not exist: ${OUTPUT_DIR}\x1b[0m`);
  process.exit(1);
}

// ─── Load config file if it exists ────────────────────────────────────────────

const configPath = path.join(OUTPUT_DIR, '.synapse.config.json');
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg.gitBackup !== undefined) GIT_BACKUP = cfg.gitBackup;
    if (cfg.dryRun !== undefined) DRY_RUN = cfg.dryRun;
    if (cfg.blockedPaths) console.log(`   Loaded ${cfg.blockedPaths.length} blocked paths from config`);
    console.log(`\x1b[32m📄 Loaded config from .synapse.config.json\x1b[0m\n`);
  } catch (e) {
    console.warn(`\x1b[33m⚠️  Config parse error: ${e.message}\x1b[0m\n`);
  }
}

// Also support legacy .acs.config.json
const legacyConfigPath = path.join(OUTPUT_DIR, '.acs.config.json');
if (!fs.existsSync(configPath) && fs.existsSync(legacyConfigPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(legacyConfigPath, 'utf8'));
    if (cfg.gitBackup !== undefined) GIT_BACKUP = cfg.gitBackup;
    if (cfg.dryRun !== undefined) DRY_RUN = cfg.dryRun;
    console.log(`\x1b[32m📄 Loaded legacy config from .acs.config.json\x1b[0m\n`);
  } catch (_) { }
}

// ─── File Tree ────────────────────────────────────────────────────────────────

function getFileTree(dir, prefix = '') {
  let files = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files = files.concat(getFileTree(path.join(dir, entry.name), relPath));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (!IGNORE_EXTENSIONS.has(ext)) {
        files.push(relPath);
      }
    }
  }
  return files;
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ port: PORT, maxPayload: 5 * 1024 * 1024 }, () => {
  console.log(`\x1b[32m✅ Listening on ws://localhost:${PORT}\x1b[0m\n`);
});

wss.on('connection', (ws, req) => {
  // Reject connections when too many clients are already connected
  const MAX_CLIENTS = 50;
  if (wss.clients.size > MAX_CLIENTS) {
    console.log(`\x1b[33m⚠️  Rejected connection (${wss.clients.size} clients, limit ${MAX_CLIENTS})\x1b[0m`);
    ws.close(1013, 'Too many connections');
    return;
  }

  const activeCount = wss.clients.size;
  console.log(`\x1b[34m🔌 Tab connected (${activeCount} active)\x1b[0m`);

  // Per-client rate limiter: max 10 code_block messages per 5 seconds
  const rateLimit = { count: 0, windowStart: Date.now() };
  const RATE_LIMIT_MAX = 10;
  const RATE_LIMIT_WINDOW = 5000;

  // Send server info
  ws.send(JSON.stringify({
    type: 'SERVER_INFO',
    outputDir: OUTPUT_DIR,
    gitBackup: GIT_BACKUP,
    dryRun: DRY_RUN,
    version: '3.0.0'
  }));

  // Send project file tree for smart filename resolution
  const fileTree = getFileTree(OUTPUT_DIR);
  ws.send(JSON.stringify({
    type: 'FILE_TREE',
    files: fileTree,
    count: fileTree.length
  }));
  console.log(`\x1b[34m📂 Sent file tree: ${fileTree.length} files\x1b[0m`);

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (data.type === 'code_block') {
        // Rate limit code_block messages
        const now = Date.now();
        if (now - rateLimit.windowStart > RATE_LIMIT_WINDOW) {
          rateLimit.count = 0;
          rateLimit.windowStart = now;
        }
        rateLimit.count++;
        if (rateLimit.count > RATE_LIMIT_MAX) {
          console.log(`\x1b[33m⚠️  Rate limited: ${rateLimit.count} code_blocks in ${RATE_LIMIT_WINDOW}ms\x1b[0m`);
          ws.send(JSON.stringify({
            type: 'ACK', filename: data.filename || 'unknown', mode: 'rate_limited',
            status: 'error', message: 'Rate limited — too many messages, slow down'
          }));
          return;
        }
        handleCodeBlock(data, ws);
      }
      if (data.type === 'confirm_response') handleConfirmResponse(data, ws);
      if (data.type === 'set_config') handleConfigUpdate(data, ws);
      if (data.type === 'request_file_tree') {
        const tree = getFileTree(OUTPUT_DIR);
        ws.send(JSON.stringify({ type: 'FILE_TREE', files: tree, count: tree.length }));
      }
      if (data.type === 'request_file_content') {
        handleFileContentRequest(data, ws);
      }
    } catch (e) {
      console.error(`\x1b[31m❌ Parse error: ${e.message}\x1b[0m`);
    }
  });

  ws.on('close', () => {
    // Clean up any pending confirmations for this client
    for (const [id, pending] of pendingConfirmations) {
      if (pending.ws === ws) {
        clearTimeout(pending.timeout);
        pendingConfirmations.delete(id);
      }
    }
    console.log('\x1b[34m🔌 Extension disconnected\x1b[0m');
  });
  ws.on('error', (e) => console.error(`\x1b[31mWS error: ${e.message}\x1b[0m`));
});

// ─── Config Update Handler ────────────────────────────────────────────────────

function handleFileContentRequest(data, ws) {
  const filename = data.filename;
  if (!filename) {
    ws.send(JSON.stringify({ type: 'FILE_CONTENT', filename: '', error: 'No filename provided' }));
    return;
  }
  try {
    const fullPath = safePath(filename);
    if (!fs.existsSync(fullPath)) {
      ws.send(JSON.stringify({ type: 'FILE_CONTENT', filename, error: 'File not found' }));
      return;
    }
    const stat = fs.statSync(fullPath);
    // Limit to 500KB to avoid flooding the WebSocket
    if (stat.size > 500 * 1024) {
      ws.send(JSON.stringify({ type: 'FILE_CONTENT', filename, error: 'File too large (>500KB)' }));
      return;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const ext = path.extname(filename).slice(1) || 'txt';
    ws.send(JSON.stringify({ type: 'FILE_CONTENT', filename, content, extension: ext, lines: content.split('\n').length }));
    console.log(`\x1b[34m📄 Sent file content: ${filename} (${content.split('\n').length} lines)\x1b[0m`);
  } catch (e) {
    ws.send(JSON.stringify({ type: 'FILE_CONTENT', filename, error: e.message }));
  }
}

function handleConfigUpdate(data, ws) {
  if (data.dryRun !== undefined) DRY_RUN = data.dryRun;
  if (data.gitBackup !== undefined) GIT_BACKUP = data.gitBackup;
  console.log(`\x1b[35m⚙️  Config updated: dryRun=${DRY_RUN}, gitBackup=${GIT_BACKUP}\x1b[0m`);
}

// ─── Confirmation Flow ────────────────────────────────────────────────────────

function requestConfirmation(ws, filename, mode, preview, executeWrite, newCode) {
  // Per-filename+mode dedup: skip only if a confirmation with the SAME mode for this file is already pending
  const dedupKey = `${filename}::${mode}`;
  const now = Date.now();
  const lastConfirm = recentConfirmFiles.get(dedupKey);
  if (lastConfirm && (now - lastConfirm) < CONFIRM_FILE_DEDUP_WINDOW) {
    // Check if there's already an active confirmation for this exact file+mode
    for (const [, pending] of pendingConfirmations) {
      if (pending.filename === filename && pending.mode === mode && pending.ws === ws) {
        console.log(`\x1b[33m⏭️  Skipped duplicate confirmation for ${filename} (${mode})\x1b[0m`);
        return;
      }
    }
  }
  recentConfirmFiles.set(dedupKey, now);

  const confirmId = ++confirmIdCounter;

  const timeout = setTimeout(() => {
    if (pendingConfirmations.has(confirmId)) {
      pendingConfirmations.delete(confirmId);
      console.log(`\x1b[33m⏰ Confirmation timed out: ${filename}\x1b[0m`);
      ws.send(JSON.stringify({
        type: 'ACK', filename, mode,
        status: 'timeout', message: `Confirmation timed out for ${filename}`
      }));
    }
  }, CONFIRM_TIMEOUT_MS);

  pendingConfirmations.set(confirmId, { ws, filename, mode, executeWrite, timeout });

  // Read existing file for diff preview (truncate if large)
  let existingSnippet = null;
  try {
    const fullPath = safePath(filename);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      // Send up to 80 lines for diff preview — enough for context, not a flood
      existingSnippet = lines.length > 80 ? lines.slice(0, 80).join('\n') + '\n...' : content;
    }
  } catch (_) { }

  // Send up to 80 lines of new code for preview
  let newSnippet = null;
  if (newCode) {
    const lines = newCode.split('\n');
    newSnippet = lines.length > 80 ? lines.slice(0, 80).join('\n') + '\n...' : newCode;
  }

  ws.send(JSON.stringify({
    type: 'CONFIRM_WRITE',
    confirmId,
    filename,
    mode,
    preview,
    existing: existingSnippet,
    incoming: newSnippet
  }));

  console.log(`\x1b[33m⏳ Awaiting confirmation #${confirmId}: ${mode} → ${filename}\x1b[0m`);
}

function handleConfirmResponse(data, ws) {
  const { confirmId, approved } = data;
  const pending = pendingConfirmations.get(confirmId);
  if (!pending) {
    console.log(`\x1b[33m⚠️  Unknown/expired confirmation #${confirmId}\x1b[0m`);
    return;
  }

  clearTimeout(pending.timeout);
  pendingConfirmations.delete(confirmId);

  if (!approved) {
    console.log(`\x1b[31m✋ Rejected: ${pending.mode} → ${pending.filename}\x1b[0m`);
    ws.send(JSON.stringify({
      type: 'ACK', filename: pending.filename, mode: pending.mode,
      status: 'rejected', message: `Write rejected by user`
    }));
    addHistory(pending.filename, pending.mode, 'rejected', 'User rejected');
    return;
  }

  console.log(`\x1b[32m✅ Approved: ${pending.mode} → ${pending.filename}\x1b[0m`);
  // Execute the actual write
  pending.executeWrite();
}

// ─── Code Block Handler ──────────────────────────────────────────────────────

function handleCodeBlock(data, ws) {
  // If extension already determined the mode, use it
  if (data.mode === 'search_replace' && data.patches) {
    return handleSearchReplace(data, ws);
  }
  if (data.mode === 'smart_patch') {
    return handleSmartPatch(data, ws);
  }

  // Otherwise, let processCode determine the mode
  const processed = processCode(data.code, data.filename);
  if (!processed) {
    console.log(`\x1b[33m⚠️  Ignored block (no valid filename)\x1b[0m`);
    return;
  }

  const { mode, filename } = processed;
  const modeColors = {
    overwrite: '\x1b[36m', patch: '\x1b[35m', insert: '\x1b[34m',
    delete: '\x1b[31m', create: '\x1b[32m', search_replace: '\x1b[33m',
    snippet_merge: '\x1b[32m', smart_patch: '\x1b[35m'
  };
  console.log(`\n${modeColors[mode] || ''}📦 ${mode.toUpperCase()} → ${filename}\x1b[0m`);

  if (DRY_RUN) {
    console.log(`   \x1b[33m🔍 DRY-RUN: Would ${mode} ${filename}\x1b[0m`);
    ws.send(JSON.stringify({
      type: 'ACK', filename, mode,
      status: 'ok', message: `DRY-RUN: Would ${mode} file`
    }));
    addHistory(filename, mode, 'dry-run', `Would ${mode}`);
    return;
  }

  // Build preview for confirmation
  const exists = (() => { try { return fs.existsSync(safePath(filename)); } catch (_) { return false; } })();
  let preview;
  if (mode === 'snippet_merge') {
    const snippetLines = processed.code.split('\n').length;
    preview = `MERGE snippet (${snippetLines} lines) into existing file: ${filename}`;
  } else if (mode === 'overwrite' && exists) {
    try {
      const existingLines = fs.readFileSync(safePath(filename), 'utf8').split('\n').length;
      const newLines = processed.code.split('\n').length;
      preview = `OVERWRITE entire file (${existingLines} → ${newLines} lines): ${filename}`;
    } catch (_) {
      preview = `OVERWRITE existing file: ${filename}`;
    }
  } else if (!exists) {
    preview = `CREATE new file: ${filename}`;
  } else {
    preview = `${mode.toUpperCase()} file: ${filename}`;
  }

  // Request confirmation before writing (pass newCode for diff preview)
  requestConfirmation(ws, filename, mode, preview, () => {
    if (GIT_BACKUP && mode !== 'delete') gitCommitBefore(filename);

    let result;
    switch (mode) {
      case 'search_replace': result = applySearchReplace(filename, processed.patches); break;
      case 'smart_patch': result = applySmartPatch(filename, processed.code); break;
      case 'snippet_merge': result = applySnippetMerge(filename, processed.code); break;
      case 'patch': result = patchFile(filename, processed.patches); break;
      case 'insert': result = insertLines(filename, processed.lineNumber, processed.code); break;
      case 'delete': result = deleteLines(filename, processed.fromLine, processed.toLine); break;
      default: result = writeFile(filename, processed.code); break;
    }

    const statusColor = result.success ? '\x1b[32m' : '\x1b[31m';
    console.log(`   ${statusColor}${result.success ? '✅' : '❌'} ${result.message}\x1b[0m`);

    if (result.success) totalSynced++; else totalErrors++;
    addHistory(filename, mode, result.success ? 'ok' : 'error', result.message);

    ws.send(JSON.stringify({
      type: 'ACK', filename, mode,
      status: result.success ? 'ok' : 'error',
      message: result.message
    }));

    if (result.success) debouncedBroadcastFileTree();
  }, processed.code || null);
}

// ─── SEARCH/REPLACE Handler (from extension-detected blocks) ──────────────────

function handleSearchReplace(data, ws) {
  const filename = data.filename;
  console.log(`\n\x1b[33m📦 SEARCH/REPLACE → ${filename} (${data.patches.length} blocks)\x1b[0m`);

  if (DRY_RUN) {
    console.log(`   \x1b[33m🔍 DRY-RUN: Would apply ${data.patches.length} edits to ${filename}\x1b[0m`);
    ws.send(JSON.stringify({
      type: 'ACK', filename, mode: 'search_replace',
      status: 'ok', message: `DRY-RUN: Would apply ${data.patches.length} edits`
    }));
    addHistory(filename, 'search_replace', 'dry-run', `Would apply ${data.patches.length} edits`);
    return;
  }

  const preview = `SEARCH/REPLACE: ${data.patches.length} edit(s) in ${filename}`;
  const patchPreview = data.patches.map(p => `- "${p.find.split('\n')[0].slice(0, 40)}..." → "${p.replace.split('\n')[0].slice(0, 40)}..."`).join('\n');

  requestConfirmation(ws, filename, 'search_replace', preview, () => {
    if (GIT_BACKUP) gitCommitBefore(filename);

    const result = applySearchReplace(filename, data.patches);
    const statusColor = result.success ? '\x1b[32m' : '\x1b[31m';
    console.log(`   ${statusColor}${result.success ? '✅' : '❌'} ${result.message}\x1b[0m`);

    if (result.success) totalSynced++; else totalErrors++;
    addHistory(filename, 'search_replace', result.success ? 'ok' : 'error', result.message);

    ws.send(JSON.stringify({
      type: 'ACK', filename, mode: 'search_replace',
      status: result.success ? 'ok' : 'error',
      message: result.message
    }));

    if (result.success) debouncedBroadcastFileTree();
  }, patchPreview);
}

// ─── Smart Patch Handler (code with "...existing code..." markers) ────────────

function handleSmartPatch(data, ws) {
  const filename = data.filename;
  console.log(`\n\x1b[35m📦 SMART PATCH → ${filename}\x1b[0m`);

  if (DRY_RUN) {
    ws.send(JSON.stringify({
      type: 'ACK', filename, mode: 'smart_patch',
      status: 'ok', message: `DRY-RUN: Would smart-patch ${filename}`
    }));
    addHistory(filename, 'smart_patch', 'dry-run', 'Would smart-patch');
    return;
  }

  const preview = `SMART PATCH: merge snippet into ${filename}`;

  requestConfirmation(ws, filename, 'smart_patch', preview, () => {
    if (GIT_BACKUP) gitCommitBefore(filename);

    const result = applySmartPatch(filename, data.code);
    const statusColor = result.success ? '\x1b[32m' : '\x1b[31m';
    console.log(`   ${statusColor}${result.success ? '✅' : '❌'} ${result.message}\x1b[0m`);

    if (result.success) totalSynced++; else totalErrors++;
    addHistory(filename, 'smart_patch', result.success ? 'ok' : 'error', result.message);

    ws.send(JSON.stringify({
      type: 'ACK', filename, mode: 'smart_patch',
      status: result.success ? 'ok' : 'error',
      message: result.message
    }));

    if (result.success) debouncedBroadcastFileTree();
  }, data.code);
}

// ─── Broadcast file tree to all connected clients (debounced) ──────────────────

let broadcastFileTreeTimer = null;

function broadcastFileTree() {
  const tree = getFileTree(OUTPUT_DIR);
  const msg = JSON.stringify({ type: 'FILE_TREE', files: tree, count: tree.length });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch (_) { }
    }
  }
}

function debouncedBroadcastFileTree() {
  if (broadcastFileTreeTimer) clearTimeout(broadcastFileTreeTimer);
  broadcastFileTreeTimer = setTimeout(() => {
    broadcastFileTreeTimer = null;
    broadcastFileTree();
  }, 2000); // Coalesce rapid writes into a single tree broadcast
}

// ─── History ──────────────────────────────────────────────────────────────────

function addHistory(filename, mode, status, message) {
  history.unshift({ timestamp: Date.now(), filename, mode, status, message });
  if (history.length > MAX_HISTORY) history.pop();
}

// ─── Partial Snippet Detection ────────────────────────────────────────────────

function looksLikePartialSnippet(code) {
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

// ─── Code Processor ───────────────────────────────────────────────────────────

function processCode(raw, hintFilename) {
  let code = raw.replace(/^```[\w-]*\n/, '').replace(/\n```$/, '').trim();

  // Strip bare language label from first line (ChatGPT/Claude DOM includes
  // the code-block header as visible text, e.g., "HTML", "JavaScript")
  const codeLines = code.split('\n');
  if (/^(html|css|javascript|typescript|python|java|ruby|php|go|rust|c|cpp|c\+\+|c#|csharp|swift|kotlin|scala|r|sql|shell|bash|powershell|markdown|json|xml|yaml|toml|dockerfile|makefile|plaintext|jsx|tsx|js|ts|py|rb|rs|cs|sh|zsh|vue|svelte|dart|lua|perl|diff|patch|http|nginx|text)$/i.test(codeLines[0]?.trim())) {
    codeLines.shift();
    code = codeLines.join('\n').trim();
  }

  // Strip SEARCH/REPLACE markers for filename extraction
  const cleanCode = code
    .replace(/<<<<<<<?[ \t]*SEARCH[ \t]*/g, '')
    .replace(/>>>>>>>?[ \t]*REPLACE[ \t]*/g, '')
    .replace(/^={5,}$/gm, '');

  const lines = cleanCode.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Extract filename from comment on first line
  const patterns = [
    /^(?:\/\/|#|--)\s*([\w][\w\/\\\-.]*\.\w{1,10})$/,
    /^\/\*\s*([\w][\w\/\\\-.]*\.\w{1,10})\s*\*\/$/,
    /^<!--\s*([\w][\w\/\\\-.]*\.\w{1,10})\s*-->$/,
    /^;\s*([\w][\w\/\\\-.]*\.\w{1,10})$/,
    /^%\s*([\w][\w\/\\\-.]*\.\w{1,10})$/,
    /^rem\s+([\w][\w\/\\\-.]*\.\w{1,10})$/i,
    /^(?:\/\/|#|--)\s*(?:file|path|filename):\s*([\w][\w\/\\\-.]*\.\w{1,10})$/i,
  ];

  let filename = hintFilename || null;

  if (!filename) {
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      for (const pat of patterns) {
        const m = lines[i].match(pat);
        if (m) { filename = m[1].replace(/\\/g, '/'); break; }
      }
      if (filename) break;
    }
  }
  if (!filename) return null;

  // Find the body (code after the filename comment line)
  let startIndex = 0;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    for (const pat of patterns) {
      if (lines[i].match(pat)) { startIndex = i + 1; break; }
    }
    if (startIndex !== 0) break;
  }
  // Use original code lines (not trimmed) to preserve indentation
  const origLines = code.split('\n');
  let origStart = 0;
  for (let i = 0; i < Math.min(origLines.length, 10); i++) {
    const trimmed = origLines[i].trim();
    for (const pat of patterns) {
      if (trimmed.match(pat)) { origStart = i + 1; break; }
    }
    if (origStart !== 0) break;
  }
  const body = origLines.slice(origStart).join('\n').trim();

  // ── SEARCH/REPLACE MODE ──
  const srBlocks = parseSearchReplaceFromCode(body);
  if (srBlocks.length > 0) {
    return { mode: 'search_replace', filename, patches: srBlocks };
  }

  // ── UNIFIED DIFF MODE ──
  if (body.includes('@@ ') && (body.includes('--- a/') || body.includes('+++ b/'))) {
    const patches = parseUnifiedDiff(body);
    if (patches.length > 0) return { mode: 'patch', filename, patches };
  }

  // ── PATCH MODE ──
  if (body.includes('@patch') || body.includes('@find')) {
    const patches = parsePatch(body);
    if (patches.length > 0) return { mode: 'patch', filename, patches };
  }

  // ── INSERT MODE ──
  const insertMatch = body.match(/^(?:\/\/|#)\s*@insert:(\d+)\n([\s\S]*)$/m);
  if (insertMatch) {
    return { mode: 'insert', filename, lineNumber: parseInt(insertMatch[1]), code: insertMatch[2].trim() };
  }

  // ── DELETE MODE ──
  const deleteMatch = body.match(/^(?:\/\/|#)\s*@delete:(\d+)-(\d+)$/m);
  if (deleteMatch) {
    return { mode: 'delete', filename, fromLine: parseInt(deleteMatch[1]), toLine: parseInt(deleteMatch[2]) };
  }

  // ── SMART PATCH MODE (partial snippet detection) ──
  // If the code has truncation/ellipsis markers, treat as smart patch
  if (looksLikePartialSnippet(body)) {
    return { mode: 'smart_patch', filename, code: body };
  }

  // ── SNIPPET GUARD — detect partial code for existing files ──
  // If the file already exists and the new code is significantly smaller,
  // it's almost certainly a snippet, not a full replacement.
  try {
    const existingPath = safePath(filename);
    if (fs.existsSync(existingPath)) {
      const existingContent = fs.readFileSync(existingPath, 'utf8');
      const existingLines = existingContent.split('\n').length;
      const newLines = body.split('\n').length;
      const ratio = newLines / existingLines;

      // Case 1: Tiny snippet (1-5 lines) targeting ANY existing file
      // A 1-5 line block is virtually never a full file replacement.
      // Route through snippet_merge which will fail safely if it can't match.
      if (newLines <= 5 && existingLines > newLines) {
        return { mode: 'snippet_merge', filename, code: body };
      }

      // Case 2: snippet is less than 60% of the existing file size
      if (ratio < 0.6 && existingLines > 5) {
        return { mode: 'snippet_merge', filename, code: body };
      }
    }
  } catch (_) { /* file doesn't exist or blocked — fall through to overwrite (create) */ }

  // ── OVERWRITE MODE (default — new files or full replacements) ──
  return { mode: 'overwrite', filename, code: body };
}

// ─── SEARCH/REPLACE parser ────────────────────────────────────────────────────

function parseSearchReplaceFromCode(body) {
  const blocks = [];
  const gitRegex = /<<<<<<<?[ \t]*SEARCH[ \t]*\n([\s\S]*?)\n={5,}\n([\s\S]*?)\n>>>>>>>?[ \t]*REPLACE/g;
  let m;
  while ((m = gitRegex.exec(body)) !== null) {
    blocks.push({ find: m[1], replace: m[2] });
  }
  const aiRegex = /(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*Find (?:this|code)[^]*?:\s*(?:-->|\*\/)?\s*\n)([\s\S]*?)(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*Replace (?:with|code)[^]*?:\s*(?:-->|\*\/)?\s*\n)([\s\S]*?)(?=(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*Find (?:this|code)[^]*?:)|$)/gi;
  while ((m = aiRegex.exec(body)) !== null) {
    blocks.push({ find: m[1].replace(/\n$/, ''), replace: m[2].replace(/\n$/, '') });
  }
  return blocks;
}

// ─── Patch Parser (multi-line) ───────────────────────────────────────────────

function parsePatch(body) {
  const patches = [];
  const sections = body.split(/\n\s*---+\s*\n/);

  for (const section of sections) {
    const multiFind = section.match(/@find\s*\{([\s\S]*?)\}/);
    const multiReplace = section.match(/@replace\s*\{([\s\S]*?)\}/);
    if (multiFind) {
      patches.push({
        find: multiFind[1].trim(),
        replace: multiReplace ? multiReplace[1].trim() : ''
      });
      continue;
    }
    const findMatch = section.match(/@find:\s*(.+?)(?:\n|$)/);
    const replaceMatch = section.match(/@replace:\s*([\s\S]*?)(?=\n@|\s*$)/);
    if (findMatch) {
      patches.push({
        find: findMatch[1].trim(),
        replace: replaceMatch ? replaceMatch[1].trim() : ''
      });
    }
  }
  return patches;
}

// ─── Unified Diff Parser ─────────────────────────────────────────────────────

function parseUnifiedDiff(diffText) {
  const patches = [];
  const hunks = diffText.split(/^@@.*@@$/m).slice(1);
  for (const hunk of hunks) {
    const lines = hunk.split('\n').filter(l => l !== '');
    let find = '', replace = '';
    for (const line of lines) {
      if (line.startsWith('-')) find += line.slice(1) + '\n';
      else if (line.startsWith('+')) replace += line.slice(1) + '\n';
      else { find += line.slice(1) + '\n'; replace += line.slice(1) + '\n'; }
    }
    if (find.trim()) patches.push({ find: find.trimEnd(), replace: replace.trimEnd() });
  }
  return patches;
}

// ─── File Operations ──────────────────────────────────────────────────────────

function safePath(filename) {
  const normalized = filename.replace(/\\/g, '/').replace(/^\//, '');
  const resolved = path.resolve(OUTPUT_DIR, normalized);
  const expectedDir = path.resolve(OUTPUT_DIR) + path.sep;
  if (!resolved.startsWith(expectedDir) && resolved !== path.resolve(OUTPUT_DIR)) {
    throw new Error(`Path traversal blocked: ${filename}`);
  }
  const BLOCKED = ['manifest.json', 'content.js', 'background.js', 'popup.js', 'popup.html', 'package-lock.json'];
  const basename = path.basename(resolved);
  if (BLOCKED.includes(basename)) {
    throw new Error(`Blocked file: ${basename}`);
  }
  return resolved;
}

// ─── SEARCH/REPLACE apply ─────────────────────────────────────────────────────

function applySearchReplace(filename, patches) {
  try {
    const fullPath = safePath(filename);

    // If file doesn't exist and there's only one "replace" with empty "find",
    // treat it as a new file creation
    if (!fs.existsSync(fullPath)) {
      if (patches.length === 1 && patches[0].find.trim() === '') {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, patches[0].replace, 'utf8');
        return { success: true, message: `Created ${filename}` };
      }
      return { success: false, message: `File not found: ${filename}` };
    }

    let content = fs.readFileSync(fullPath, 'utf8');
    let applied = 0;

    for (const { find, replace } of patches) {
      // Try exact match first
      if (content.includes(find)) {
        content = content.split(find).join(replace);
        applied++;
        console.log(`   \x1b[33m🔧 Applied: "${find.split('\n')[0].slice(0, 50)}..."\x1b[0m`);
        continue;
      }

      // Fuzzy match: normalize whitespace and try again
      const fuzzyResult = fuzzyReplace(content, find, replace);
      if (fuzzyResult !== null) {
        content = fuzzyResult;
        applied++;
        console.log(`   \x1b[33m🔧 Fuzzy-applied: "${find.split('\n')[0].slice(0, 50)}..."\x1b[0m`);
        continue;
      }

      console.log(`   \x1b[31m⚠️  No match: "${find.split('\n')[0].slice(0, 50)}..."\x1b[0m`);
    }

    if (applied > 0) {
      fs.writeFileSync(fullPath, content, 'utf8');
    }
    return {
      success: applied > 0,
      message: `${applied}/${patches.length} edits applied`
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── Smart Patch (code with "...existing code..." markers) ────────────────────

function applySmartPatch(filename, rawCode) {
  try {
    const fullPath = safePath(filename);

    // Clean the code: remove filename comment from first lines
    let code = rawCode.replace(/^```[\w-]*\n/, '').replace(/\n```$/, '').trim();
    const codeLines = code.split('\n');

    // Remove the first line if it's a filename comment
    const fnPatterns = [
      /^(?:\/\/|#|--)\s*[\w][\w\/\\\-.]*\.\w{1,10}$/,
      /^\/\*\s*[\w][\w\/\\\-.]*\.\w{1,10}\s*\*\/$/,
      /^<!--\s*[\w][\w\/\\\-.]*\.\w{1,10}\s*-->$/,
    ];
    let startIdx = 0;
    for (let i = 0; i < Math.min(codeLines.length, 3); i++) {
      if (fnPatterns.some(p => codeLines[i].trim().match(p))) {
        startIdx = i + 1;
        break;
      }
    }
    const cleanLines = codeLines.slice(startIdx);

    // Detect marker lines: "...existing code...", bare ellipsis, truncation phrases
    const markerRegex = /^[ \t]*(?:\/\/|#|--|\/\*|\*)?\s*(?:\.{3,}|…)\s*(?:\*\/)?\s*$|^[ \t]*(?:\/\/|#|--|\/\*|\*)\s*\.{2,}\s*(?:existing|rest|other|remaining|previous|more)\s+(?:code|content|implementation|file|logic|of the|unchanged)|^[ \t]*<!--\s*\.{3,}\s*-->|^[ \t]*(?:\/\/|#|--|\/\*|\*)\s*(?:\(?\s*(?:rest|remaining|unchanged|same as|keep|stays?|no changes?|untouched|omitted|truncated|snip|collapsed|hidden|abbreviated))/i;

    if (!fs.existsSync(fullPath)) {
      // File doesn't exist — write without marker lines
      const filtered = cleanLines.filter(l => !markerRegex.test(l)).join('\n').trim();
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, filtered + '\n', 'utf8');
      return { success: true, message: `Created ${filename} (markers stripped)` };
    }

    const existingContent = fs.readFileSync(fullPath, 'utf8');

    // Extract the concrete (non-marker) sections from the AI output
    // Each section is a chunk of actual code between markers
    const sections = [];
    let currentSection = [];
    for (const line of cleanLines) {
      if (markerRegex.test(line)) {
        if (currentSection.length > 0) {
          sections.push(currentSection.join('\n'));
          currentSection = [];
        }
      } else {
        currentSection.push(line);
      }
    }
    if (currentSection.length > 0) {
      sections.push(currentSection.join('\n'));
    }

    if (sections.length === 0) {
      return { success: false, message: 'No concrete code sections found' };
    }

    // For each section, try to find its anchor in the existing file and replace
    let content = existingContent;
    let applied = 0;

    for (const section of sections) {
      const sectionLines = section.split('\n');
      if (sectionLines.length < 2) continue;

      // Use the first and last non-empty lines as anchors
      const firstLine = sectionLines.find(l => l.trim().length > 0);
      const lastLine = [...sectionLines].reverse().find(l => l.trim().length > 0);

      if (!firstLine) continue;

      // Find this section's anchor in the existing content
      const firstIdx = content.indexOf(firstLine.trim());
      if (firstIdx !== -1) {
        // Found anchor — find the extent to replace
        const lastIdx = lastLine ? content.indexOf(lastLine.trim(), firstIdx) : -1;
        if (lastIdx !== -1) {
          const endIdx = lastIdx + lastLine.trim().length;
          const before = content.substring(0, firstIdx);
          const after = content.substring(endIdx);
          // Find the correct indentation
          const lineStart = content.lastIndexOf('\n', firstIdx) + 1;
          const indent = content.substring(lineStart, firstIdx).match(/^(\s*)/)?.[1] || '';
          content = before + section.split('\n').map((l, i) => i === 0 ? l : l).join('\n') + after;
          applied++;
          continue;
        }
      }

      // If anchors not found, try fuzzy matching the first few lines
      const anchor = sectionLines.slice(0, 3).join('\n');
      if (content.includes(anchor)) {
        // Find the matching region in content
        const start = content.indexOf(anchor);
        // Estimate end by matching similar length
        const sectionLen = section.length;
        const end = Math.min(start + sectionLen + 200, content.length);
        const region = content.substring(start, end);
        // Find end of the matching block (look for the last line of section in region)
        const sectionLast = sectionLines[sectionLines.length - 1]?.trim();
        const regionEndIdx = sectionLast ? region.indexOf(sectionLast) : -1;
        if (regionEndIdx !== -1) {
          const absEnd = start + regionEndIdx + sectionLast.length;
          content = content.substring(0, start) + section + content.substring(absEnd);
          applied++;
        }
      }
    }

    if (applied > 0) {
      fs.writeFileSync(fullPath, content, 'utf8');
      return { success: true, message: `Smart-patched ${applied} section(s)` };
    }

    // Fallback: do NOT silently overwrite — partial snippets should never replace the full file
    return { success: false, message: `Smart-patch failed: could not match any sections in ${filename}. Use SEARCH/REPLACE for precise edits.` };

  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── Snippet Merge (auto-detected partial code without markers) ────────────────
// This is the key intelligence: when AI outputs a snippet without any markers,
// we figure out WHERE it belongs in the existing file and surgically replace
// only that section — like Claude Code / Antigravity do.

function applySnippetMerge(filename, snippetCode) {
  try {
    const fullPath = safePath(filename);
    if (!fs.existsSync(fullPath)) {
      // No existing file — create it
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, snippetCode + '\n', 'utf8');
      return { success: true, message: `Created ${filename}` };
    }

    const existingContent = fs.readFileSync(fullPath, 'utf8');
    const existingLines = existingContent.split('\n');
    const snippetLines = snippetCode.split('\n');

    // Strategy 1: Find the best matching region using first non-trivial line as anchor
    // Look for function/class/method signatures, imports, or distinctive lines
    const anchor = findBestAnchor(snippetLines);
    if (anchor) {
      const anchorResult = anchorMerge(existingLines, snippetLines, anchor);
      if (anchorResult) {
        fs.writeFileSync(fullPath, anchorResult.join('\n'), 'utf8');
        return { success: true, message: `Merged snippet into ${filename} (anchor: line ${anchor.lineIdx + 1})` };
      }
    }

    // Strategy 2: Sliding window similarity — find the region in the existing file
    // that has the highest overlap with the snippet
    const windowResult = slidingWindowMerge(existingLines, snippetLines);
    if (windowResult) {
      fs.writeFileSync(fullPath, windowResult.join('\n'), 'utf8');
      return { success: true, message: `Merged snippet into ${filename} (similarity match)` };
    }

    // Strategy 3: Try fuzzy match on first 3 lines of snippet
    const first3 = snippetLines.slice(0, 3).map(l => l.trim()).filter(l => l.length > 0).join('\n');
    const fuzzyResult = fuzzyReplace(existingContent, first3, snippetCode);
    if (fuzzyResult !== null) {
      fs.writeFileSync(fullPath, fuzzyResult, 'utf8');
      return { success: true, message: `Merged snippet into ${filename} (fuzzy match)` };
    }

    // Strategy 4: Structural line matching for tiny snippets (1–5 lines)
    // Matches by tag name / key identifier rather than content value.
    // Example: <title>New Title</title> replaces <title>Old Title</title>
    if (snippetLines.filter(l => l.trim()).length <= 5) {
      const structResult = structuralLineMatch(existingLines, snippetLines);
      if (structResult) {
        fs.writeFileSync(fullPath, structResult.join('\n'), 'utf8');
        return { success: true, message: `Merged snippet into ${filename} (structural match)` };
      }
    }

    return {
      success: false,
      message: `Snippet merge failed for ${filename}: could not find matching region. Snippet appears to be partial (${snippetLines.length} lines vs ${existingLines.length} in file). Use SEARCH/REPLACE markers for precise edits.`
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── Structural line match for tiny snippets ──────────────────────────────────
// For each non-empty snippet line, find the best matching existing line by
// structure (same HTML tag, same CSS/JS key) and replace it in-place.
// This handles cases like: <title>New</title> replacing <title>Old</title>

function structuralLineMatch(existingLines, snippetLines) {
  const result = [...existingLines];
  let applied = 0;

  for (const snippetLine of snippetLines) {
    const trimmed = snippetLine.trim();
    if (!trimmed) continue;

    // ── HTML tag matching ──────────────────────────────────────────────────
    // Matches <tagname>, <tagname attr>, <tagname>content</tagname>
    const htmlTagMatch = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9-]*)[\s>/]/);
    if (htmlTagMatch) {
      const tagName = htmlTagMatch[1].toLowerCase();
      // Skip structural/block tags that shouldn't be replaced by a single-line snippet
      const blockTags = new Set(['div', 'section', 'article', 'main', 'header', 'footer',
        'nav', 'ul', 'ol', 'table', 'tbody', 'thead', 'tr', 'form', 'figure', 'html', 'body', 'head']);
      if (!blockTags.has(tagName)) {
        const idx = result.findIndex(l => {
          const lt = l.trim().toLowerCase();
          return lt.startsWith('<' + tagName + '>') ||
            lt.startsWith('<' + tagName + ' ') ||
            lt.startsWith('<' + tagName + '\t');
        });
        if (idx !== -1) {
          const indent = result[idx].match(/^(\s*)/)[1];
          result[idx] = indent + trimmed;
          applied++;
          console.log(`   \x1b[33m🔧 Structural HTML match: <${tagName}> at line ${idx + 1}\x1b[0m`);
          continue;
        }
      }
    }

    // ── CSS property matching ──────────────────────────────────────────────
    // Matches: property-name: value;
    const cssPropMatch = trimmed.match(/^([\w-]+)\s*:\s*.+;?\s*$/);
    if (cssPropMatch) {
      const prop = cssPropMatch[1].toLowerCase();
      const idx = result.findIndex(l => {
        const lt = l.trim().toLowerCase();
        return lt.startsWith(prop + ':') || lt.startsWith(prop + ' :');
      });
      if (idx !== -1) {
        const indent = result[idx].match(/^(\s*)/)[1];
        result[idx] = indent + trimmed;
        applied++;
        console.log(`   \x1b[33m🔧 Structural CSS match: "${prop}" at line ${idx + 1}\x1b[0m`);
        continue;
      }
    }

    // ── JS/JSON key-value matching ─────────────────────────────────────────
    // Matches: key: value, key = value, "key": value
    const kvMatch = trimmed.match(/^["']?([\w-]+)["']?\s*[:=]/);
    if (kvMatch) {
      const key = kvMatch[1];
      const idx = result.findIndex(l => {
        const lt = l.trim();
        return lt.startsWith(`"${key}":`) || lt.startsWith(`'${key}':`) ||
          lt.startsWith(`${key}:`) || lt.startsWith(`${key} :`) ||
          lt.startsWith(`${key}=`) || lt.startsWith(`${key} =`);
      });
      if (idx !== -1) {
        const indent = result[idx].match(/^(\s*)/)[1];
        result[idx] = indent + trimmed;
        applied++;
        console.log(`   \x1b[33m🔧 Structural KV match: "${key}" at line ${idx + 1}\x1b[0m`);
        continue;
      }
    }
  }

  return applied > 0 ? result : null;
}

// Find the most distinctive line in the snippet to use as an anchor
function findBestAnchor(snippetLines) {
  // Patterns that make good anchors (in priority order):
  // function/class/method definitions, export statements, distinctive assignments
  const anchorPatterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/,           // function declarations
    /^\s*(?:export\s+)?class\s+\w+/,                             // class declarations
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\(|function)/,  // arrow/function expressions
    /^\s*(?:public|private|protected|static|async)\s+\w+\s*\(/,  // class methods
    /^\s*\w+\s*\([^)]*\)\s*\{/,                                  // method shorthand
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=/,             // variable declarations
    /^\s*(?:app|router|server)\.\w+\(/,                           // express-style routes
    /^\s*(?:describe|it|test)\s*\(/,                              // test blocks
    /^\s*(?:import|from|require)\s/,                              // imports
  ];

  for (const pattern of anchorPatterns) {
    for (let i = 0; i < snippetLines.length; i++) {
      if (pattern.test(snippetLines[i]) && snippetLines[i].trim().length > 8) {
        return { lineIdx: i, text: snippetLines[i], trimmed: snippetLines[i].trim() };
      }
    }
  }

  // Fallback: first non-empty, non-trivial line (> 15 chars, not just braces/brackets)
  for (let i = 0; i < snippetLines.length; i++) {
    const t = snippetLines[i].trim();
    if (t.length > 15 && !/^[{}\[\]();,]+$/.test(t)) {
      return { lineIdx: i, text: snippetLines[i], trimmed: t };
    }
  }
  return null;
}

// Use anchor to find where snippet belongs and replace that region
function anchorMerge(existingLines, snippetLines, anchor) {
  // Find the anchor line in the existing file
  const anchorIdx = existingLines.findIndex(l => l.trim() === anchor.trimmed);
  if (anchorIdx === -1) return null;

  // The snippet starts `anchor.lineIdx` lines before the anchor
  const mergeStart = Math.max(0, anchorIdx - anchor.lineIdx);

  // Determine how far the snippet extends — find the end of the logical block
  // Try to match the last line of the snippet in the existing file
  const lastSnippetLine = [...snippetLines].reverse().find(l => l.trim().length > 0);
  if (!lastSnippetLine) return null;

  // Look for the last line of the snippet in the existing file, starting from anchor
  let mergeEnd = -1;
  for (let i = anchorIdx; i < Math.min(existingLines.length, anchorIdx + snippetLines.length + 20); i++) {
    if (existingLines[i].trim() === lastSnippetLine.trim()) {
      mergeEnd = i + 1;
      // Don't break — prefer the last match within range (handles duplicate closing braces)
    }
  }

  // If we can't find the last line, estimate the end based on snippet length
  if (mergeEnd === -1) {
    mergeEnd = Math.min(existingLines.length, mergeStart + snippetLines.length);
  }

  // Validate: the merge region should be similar in scope to the snippet
  const regionSize = mergeEnd - mergeStart;
  if (regionSize < 1) return null;

  // Perform the merge
  const result = [
    ...existingLines.slice(0, mergeStart),
    ...snippetLines,
    ...existingLines.slice(mergeEnd)
  ];
  return result;
}

// Sliding window: find the region of the existing file most similar to the snippet
function slidingWindowMerge(existingLines, snippetLines) {
  if (snippetLines.length < 3 || existingLines.length < 3) return null;

  const snippetNorm = snippetLines.map(l => l.trim()).filter(l => l.length > 0);
  if (snippetNorm.length < 2) return null;

  let bestStart = -1;
  let bestScore = 0;
  const windowSize = snippetLines.length;

  // Slide a window of snippet-size over the existing file
  for (let i = 0; i <= existingLines.length - Math.min(windowSize, 3); i++) {
    let score = 0;
    const compareLen = Math.min(windowSize, existingLines.length - i);

    for (let j = 0; j < compareLen && j < snippetNorm.length; j++) {
      const existTrimmed = existingLines[i + j].trim();
      // Exact match
      if (existTrimmed === snippetNorm[j]) {
        score += 3;
      }
      // Partial match (line starts with same prefix)
      else if (existTrimmed.length > 5 && snippetNorm[j].length > 5 &&
        existTrimmed.substring(0, 20) === snippetNorm[j].substring(0, 20)) {
        score += 1;
      }
    }

    // Normalize by window size to get a ratio
    const maxPossible = compareLen * 3;
    const ratio = score / maxPossible;

    if (score > bestScore && ratio > 0.3) { // At least 30% similarity
      bestScore = score;
      bestStart = i;
    }
  }

  if (bestStart === -1) return null;

  // Determine merge end — look for where the overlap stops
  let mergeEnd = bestStart + windowSize;

  // Refine: if the last snippet line matches somewhere, use that
  const lastSnippet = snippetLines[snippetLines.length - 1].trim();
  if (lastSnippet.length > 3) {
    for (let i = bestStart + snippetLines.length - 1; i < Math.min(existingLines.length, bestStart + windowSize + 20); i++) {
      if (existingLines[i].trim() === lastSnippet) {
        mergeEnd = i + 1;
        break;
      }
    }
  }

  mergeEnd = Math.min(mergeEnd, existingLines.length);

  const result = [
    ...existingLines.slice(0, bestStart),
    ...snippetLines,
    ...existingLines.slice(mergeEnd)
  ];
  return result;
}

// ─── Fuzzy text replacement ───────────────────────────────────────────────────
// Tries to match with normalized whitespace when exact match fails

function fuzzyReplace(content, find, replace) {
  // Normalize: collapse whitespace runs, trim each line
  function normalize(s) {
    return s.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n');
  }

  const normFind = normalize(find);
  const contentLines = content.split('\n');
  const findLines = normFind.split('\n');

  if (findLines.length === 0) return null;

  // Sliding window search
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    let match = true;
    for (let j = 0; j < findLines.length; j++) {
      if (contentLines[i + j].trim() !== findLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Preserve indentation from the first matched line
      const indent = contentLines[i].match(/^(\s*)/)[1];
      const replaceLines = replace.split('\n').map((l, idx) => {
        if (idx === 0) return indent + l.trimStart();
        // Try to preserve relative indentation
        const origIndent = find.split('\n')[0]?.match(/^(\s*)/)?.[1]?.length || 0;
        const lineIndent = l.match(/^(\s*)/)[1].length;
        const relativeIndent = Math.max(0, lineIndent - origIndent);
        return indent + ' '.repeat(relativeIndent) + l.trimStart();
      });

      const before = contentLines.slice(0, i);
      const after = contentLines.slice(i + findLines.length);
      return [...before, ...replaceLines, ...after].join('\n');
    }
  }

  return null;
}

// ─── Patch File ───────────────────────────────────────────────────────────────

function patchFile(filename, patches) {
  try {
    const fullPath = safePath(filename);
    if (!fs.existsSync(fullPath)) return { success: false, message: `File not found: ${filename}` };
    let content = fs.readFileSync(fullPath, 'utf8');
    let applied = 0;
    for (const { find, replace } of patches) {
      if (content.includes(find)) {
        content = content.split(find).join(replace);
        applied++;
        console.log(`   \x1b[35m🔧 Patched: "${find.slice(0, 50).replace(/\n/g, '↵')}"\x1b[0m`);
      } else {
        // Try fuzzy match
        const fuzzyResult = fuzzyReplace(content, find, replace);
        if (fuzzyResult !== null) {
          content = fuzzyResult;
          applied++;
          console.log(`   \x1b[35m🔧 Fuzzy-patched: "${find.slice(0, 50).replace(/\n/g, '↵')}"\x1b[0m`);
        } else {
          console.log(`   \x1b[33m⚠️  Not found: "${find.slice(0, 50).replace(/\n/g, '↵')}"\x1b[0m`);
        }
      }
    }
    if (applied > 0) {
      fs.writeFileSync(fullPath, content, 'utf8');
    }
    return { success: applied > 0, message: `${applied}/${patches.length} patches applied` };
  } catch (e) { return { success: false, message: e.message }; }
}

function insertLines(filename, afterLine, newCode) {
  try {
    const fullPath = safePath(filename);
    if (!fs.existsSync(fullPath)) return { success: false, message: `File not found: ${filename}` };
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
    lines.splice(Math.min(afterLine, lines.length), 0, ...newCode.split('\n'));
    fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');
    return { success: true, message: `Inserted ${newCode.split('\n').length} lines after line ${afterLine}` };
  } catch (e) { return { success: false, message: e.message }; }
}

function deleteLines(filename, fromLine, toLine) {
  try {
    const fullPath = safePath(filename);
    if (!fs.existsSync(fullPath)) return { success: false, message: `File not found: ${filename}` };
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
    const removed = lines.splice(fromLine - 1, toLine - fromLine + 1);
    fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');
    return { success: true, message: `Deleted ${removed.length} lines (${fromLine}-${toLine})` };
  } catch (e) { return { success: false, message: e.message }; }
}

function writeFile(filename, code) {
  try {
    const fullPath = safePath(filename);
    const exists = fs.existsSync(fullPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, code + '\n', 'utf8');
    return { success: true, message: `${exists ? 'Updated' : 'Created'} ${filename}` };
  } catch (e) { return { success: false, message: e.message }; }
}

// ─── Git Operations ───────────────────────────────────────────────────────────

function gitCommitBefore(filename) {
  try {
    const fullPath = safePath(filename);
    if (!fs.existsSync(fullPath)) return;

    // Check if git is available and we're in a repo
    execSync('git rev-parse --is-inside-work-tree', { cwd: OUTPUT_DIR, stdio: 'pipe' });

    const safeFilename = filename.replace(/[^a-zA-Z0-9._\/-]/g, '_');
    execSync('git add -A', { cwd: OUTPUT_DIR, stdio: 'pipe' });
    execSync(`git commit -m "synapse: backup before ${safeFilename}" --allow-empty`, {
      cwd: OUTPUT_DIR, stdio: 'pipe'
    });
    console.log(`   \x1b[34m📋 Git backup committed\x1b[0m`);
  } catch (_) {
    // Git not available or not a repo — skip silently
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log(`\n\x1b[36m👋 Shutting down... (${totalSynced} synced, ${totalErrors} errors)\x1b[0m\n`);
  wss.close(() => process.exit(0));
});
