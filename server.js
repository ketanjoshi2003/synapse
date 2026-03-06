// server.js — Synapse v2
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

// ─── State ────────────────────────────────────────────────────────────────────

const history = []; // { timestamp, filename, mode, status, message, backup? }
const MAX_HISTORY = 200;
let totalSynced = 0;
let totalErrors = 0;

// ─── Banner ───────────────────────────────────────────────────────────────────

console.log(`
\x1b[36m╔══════════════════════════════════════════════════╗
║            ⚡ Synapse — Server v2.0              ║
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

const configPath = path.join(OUTPUT_DIR, '.acs.config.json');
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg.gitBackup !== undefined) GIT_BACKUP = cfg.gitBackup;
    if (cfg.dryRun !== undefined) DRY_RUN = cfg.dryRun;
    if (cfg.blockedPaths) console.log(`   Loaded ${cfg.blockedPaths.length} blocked paths from config`);
    console.log(`\x1b[32m📄 Loaded config from .acs.config.json\x1b[0m\n`);
  } catch (e) {
    console.warn(`\x1b[33m⚠️  Config parse error: ${e.message}\x1b[0m\n`);
  }
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ port: PORT }, () => {
  console.log(`\x1b[32m✅ Listening on ws://localhost:${PORT}\x1b[0m\n`);
});

wss.on('connection', (ws, req) => {
  console.log(`\x1b[34m🔌 Extension connected from: ${req.socket.remoteAddress}\x1b[0m`);

  // Send server info
  ws.send(JSON.stringify({
    type: 'SERVER_INFO',
    outputDir: OUTPUT_DIR,
    gitBackup: GIT_BACKUP,
    dryRun: DRY_RUN,
    version: '2.0.0'
  }));

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (data.type === 'code_block') handleCodeBlock(data, ws);
      if (data.type === 'set_config') handleConfigUpdate(data, ws);
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
  const processed = processCode(data.code);

  if (!processed) {
    console.log(`\x1b[33m⚠️  Ignored block (no valid filename)\x1b[0m`);
    return;
  }

  const { mode, filename } = processed;
  const modeColors = { overwrite: '\x1b[36m', patch: '\x1b[35m', insert: '\x1b[34m', delete: '\x1b[31m' };
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

  // Git backup
  if (GIT_BACKUP && mode !== 'delete') gitCommitBefore(filename);

  let result;
  switch (mode) {
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
}

// ─── History ──────────────────────────────────────────────────────────────────

function addHistory(filename, mode, status, message) {
  history.unshift({ timestamp: Date.now(), filename, mode, status, message });
  if (history.length > MAX_HISTORY) history.pop();
}

// ─── Code Processor ───────────────────────────────────────────────────────────

function processCode(raw) {
  let code = raw.replace(/^```[\w-]*\n/, '').replace(/\n```$/, '').trim();
  const lines = code.split('\n');
  const firstLine = lines[0].trim();

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

  let filename = null;
  for (const pat of patterns) {
    const m = firstLine.match(pat);
    if (m) { filename = m[1].replace(/\\/g, '/'); break; }
  }
  if (!filename) return null;

  const body = lines.slice(1).join('\n').trim();

  // UNIFIED DIFF MODE
  if (body.includes('@@ ') && (body.includes('--- a/') || body.includes('+++ b/'))) {
    const patches = parseUnifiedDiff(body);
    if (patches.length > 0) return { mode: 'patch', filename, patches };
  }

  // PATCH MODE with multi-line support
  if (body.includes('@patch')) {
    const patches = parsePatch(body);
    if (patches.length > 0) return { mode: 'patch', filename, patches };
  }

  // INSERT MODE
  const insertMatch = body.match(/^(?:\/\/|#)\s*@insert:(\d+)\n([\s\S]*)$/m);
  if (insertMatch) {
    return { mode: 'insert', filename, lineNumber: parseInt(insertMatch[1]), code: insertMatch[2].trim() };
  }

  // DELETE MODE
  const deleteMatch = body.match(/^(?:\/\/|#)\s*@delete:(\d+)-(\d+)$/m);
  if (deleteMatch) {
    return { mode: 'delete', filename, fromLine: parseInt(deleteMatch[1]), toLine: parseInt(deleteMatch[2]) };
  }

  // OVERWRITE MODE (default)
  return { mode: 'overwrite', filename, code: body };
}

// ─── Patch Parser (multi-line) ───────────────────────────────────────────────

function parsePatch(body) {
  const patches = [];
  const sections = body.split(/\n\s*---+\s*\n/);

  for (const section of sections) {
    // Multi-line: @find {...} @replace {...}
    const multiFind = section.match(/@find\s*\{([\s\S]*?)\}/);
    const multiReplace = section.match(/@replace\s*\{([\s\S]*?)\}/);
    if (multiFind) {
      patches.push({
        find: multiFind[1].trim(),
        replace: multiReplace ? multiReplace[1].trim() : ''
      });
      continue;
    }
    // Single-line: @find: text / @replace: text
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
  const safe = filename.replace(/\.\./g, '').replace(/^[\/\\]/, '');
  return path.join(OUTPUT_DIR, safe);
}

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
        console.log(`   \x1b[33m⚠️  Not found: "${find.slice(0, 50).replace(/\n/g, '↵')}"\x1b[0m`);
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
    // Create .bak backup if file exists
    if (exists) {
      const bak = fullPath + `.bak.${Date.now()}`;
      fs.copyFileSync(fullPath, bak);
      console.log(`   \x1b[90m💾 Backup: ${path.basename(bak)}\x1b[0m`);
    }
    fs.writeFileSync(fullPath, code, 'utf8');
    return { success: true, message: `${exists ? 'Updated' : 'Created'} ${filename}` };
  } catch (e) { return { success: false, message: e.message }; }
}

// ─── Git Backup ───────────────────────────────────────────────────────────────

function gitCommitBefore(filename) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: OUTPUT_DIR, stdio: 'pipe' });
    execSync('git add -A', { cwd: OUTPUT_DIR, stdio: 'pipe' });
    execSync(`git commit -m "Synapse auto-backup before updating ${filename}" --allow-empty`, {
      cwd: OUTPUT_DIR, stdio: 'pipe'
    });
    console.log(`   \x1b[90m📌 Git backup committed\x1b[0m`);
  } catch (e) {
    // Not a git repo or nothing to commit — silent
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log(`\n\x1b[36m👋 Shutting down... (${totalSynced} synced, ${totalErrors} errors)\x1b[0m\n`);
  wss.close(() => process.exit(0));
});
