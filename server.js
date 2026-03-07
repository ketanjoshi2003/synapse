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

// ─── Banner ───────────────────────────────────────────────────────────────────

console.log(`
\x1b[36m╔══════════════════════════════════════════════════╗
║            \x1b[32m//\x1b[36m Synapse — Server v3.0              ║
╠══════════════════════════════════════════════════╣\x1b[0m
\x1b[37m║ WebSocket Port : \x1b[33m${PORT.toString().padEnd(32)}\x1b[37m║
║ Output Dir     : \x1b[33m${OUTPUT_DIR.length > 32 ? '...' + OUTPUT_DIR.slice(-29) : OUTPUT_DIR.padEnd(32)}\x1b[37m║
║ Git Backup     : \x1b[33m${(GIT_BACKUP ? 'ON' : 'OFF').padEnd(32)}\x1b[37m║
║ Dry-Run Mode   : \x1b[33m${(DRY_RUN ? 'ON' : 'OFF').padEnd(32)}\x1b[37m║
\x1b[36m╚══════════════════════════════════════════════════╝\x1b[0m
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
  } catch (_) {}
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

const wss = new WebSocket.Server({ port: PORT }, () => {
  console.log(`\x1b[32m✅ Listening on ws://localhost:${PORT}\x1b[0m\n`);
});

wss.on('connection', (ws, req) => {
  const activeCount = wss.clients.size;
  console.log(`\x1b[34m🔌 Tab connected (${activeCount} active)\x1b[0m`);

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
      if (data.type === 'code_block') handleCodeBlock(data, ws);
      if (data.type === 'set_config') handleConfigUpdate(data, ws);
      if (data.type === 'request_file_tree') {
        const tree = getFileTree(OUTPUT_DIR);
        ws.send(JSON.stringify({ type: 'FILE_TREE', files: tree, count: tree.length }));
      }
    } catch (e) {
      console.error(`\x1b[31m❌ Parse error: ${e.message}\x1b[0m`);
    }
  });

  ws.on('close', () => console.log('\x1b[34m🔌 Extension disconnected\x1b[0m'));
  ws.on('error', (e) => console.error(`\x1b[31mWS error: ${e.message}\x1b[0m`));
});

// ─── Config Update Handler ────────────────────────────────────────────────────

function handleConfigUpdate(data, ws) {
  if (data.dryRun !== undefined) DRY_RUN = data.dryRun;
  if (data.gitBackup !== undefined) GIT_BACKUP = data.gitBackup;
  console.log(`\x1b[35m⚙️  Config updated: dryRun=${DRY_RUN}, gitBackup=${GIT_BACKUP}\x1b[0m`);
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
    delete: '\x1b[31m', create: '\x1b[32m', search_replace: '\x1b[33m'
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

  if (GIT_BACKUP && mode !== 'delete') gitCommitBefore(filename);

  let result;
  switch (mode) {
    case 'search_replace': result = applySearchReplace(filename, processed.patches); break;
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

  // Refresh file tree after write
  if (result.success) {
    broadcastFileTree();
  }
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

  if (result.success) broadcastFileTree();
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

  if (result.success) broadcastFileTree();
}

// ─── Broadcast file tree to all connected clients ─────────────────────────────

function broadcastFileTree() {
  const tree = getFileTree(OUTPUT_DIR);
  const msg = JSON.stringify({ type: 'FILE_TREE', files: tree, count: tree.length });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch (_) {}
    }
  }
}

// ─── History ──────────────────────────────────────────────────────────────────

function addHistory(filename, mode, status, message) {
  history.unshift({ timestamp: Date.now(), filename, mode, status, message });
  if (history.length > MAX_HISTORY) history.pop();
}

// ─── Code Processor ───────────────────────────────────────────────────────────

function processCode(raw, hintFilename) {
  let code = raw.replace(/^```[\w-]*\n/, '').replace(/\n```$/, '').trim();

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

  // ── OVERWRITE MODE (default) ──
  return { mode: 'overwrite', filename, code: body };
}

// ─── SEARCH/REPLACE parser ────────────────────────────────────────────────────

function parseSearchReplaceFromCode(body) {
  const blocks = [];
  const regex = /<<<<<<<?[ \t]*SEARCH[ \t]*\n([\s\S]*?)\n={5,}\n([\s\S]*?)\n>>>>>>>?[ \t]*REPLACE/g;
  let m;
  while ((m = regex.exec(body)) !== null) {
    blocks.push({ find: m[1], replace: m[2] });
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
  if (!resolved.startsWith(path.resolve(OUTPUT_DIR))) {
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
        content = content.replace(find, replace);
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

    // Detect "...existing code..." marker lines
    const markerRegex = /^[ \t]*(?:\/\/|#|--|\/\*|\*)\s*\.{2,}\s*(?:existing|rest|other|remaining|previous|more)\s+(?:code|content|implementation)/i;

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

    // Fallback: if we couldn't match sections, overwrite the file
    const fullCode = cleanLines.filter(l => !markerRegex.test(l)).join('\n').trim();
    fs.writeFileSync(fullPath, fullCode + '\n', 'utf8');
    return { success: true, message: `Updated ${filename} (fallback overwrite)` };

  } catch (e) {
    return { success: false, message: e.message };
  }
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
    fs.writeFileSync(fullPath, content, 'utf8');
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
