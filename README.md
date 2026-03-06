# ⚡ Synapse

**The neural link between AI and your codebase.**

Works with **Claude**, **ChatGPT**, **Gemini**, **DeepSeek**, **Copilot**, **Grok**, **Poe**, **Mistral**, and **HuggingFace Chat**.

```
[Any AI Chat Tab] → [Chrome Extension] → [WebSocket] → [Local Server] → [Your Files]
```

---

## Setup (2 steps)

### Step 1 — Run the Local Server

```bash
cd extension
npm install
node server.js --output /path/to/your/project
```

**Options:**
| Flag | Description |
|------|-------------|
| `--output <dir>` | Target project directory (default: current directory) |
| `--port <num>` | WebSocket port (default: 3131) |
| `--git` | Enable git auto-backup before each file write |
| `--dry-run` | Preview mode — shows what would change without writing |

You'll see:
```
╔══════════════════════════════════════════════════╗
║            ⚡ Synapse — Server v2.0              ║
╠══════════════════════════════════════════════════╣
║ WebSocket Port : 3131                            ║
║ Output Dir     : C:\projects\my-app              ║
║ Git Backup     : OFF                             ║
║ Dry-Run Mode   : OFF                             ║
╚══════════════════════════════════════════════════╝
```

### Step 2 — Install the Chrome Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **"Load unpacked"** → select the `extension/` folder
4. Open any supported AI chat — you'll see a green **⚡ Synapse: ON** badge

---

## How It Works

1. Chat with any AI and ask it to write code
2. The extension detects code blocks in real-time via DOM observers
3. First line of code must be a filename comment (see below)
4. Extension sends it over WebSocket to your local server
5. Server writes/patches/inserts/deletes the file in your project

---

## Filename Comment Formats

The **first line** of each code block must be a filename comment. All common comment styles are supported:

```javascript
// src/components/Button.tsx       ← JS, TS, C, C++, Java, Go, Rust
```
```python
# utils/helpers.py                 ← Python, Ruby, Bash, YAML, Dockerfile
```
```sql
-- migrations/001_init.sql         ← SQL, Haskell, Lua
```
```css
/* styles/global.css */            ← CSS, C multi-line
```
```html
<!-- templates/layout.html -->     ← HTML, XML
```
```ini
; config/settings.ini             ← INI, Lisp, Assembly
```

You can also use the explicit format:
```
// file: src/utils/helper.ts
```

---

## Write Modes

### 1. Overwrite (default)
Writes the entire file. Creates directories if needed. Backs up existing files.

```javascript
// src/utils/math.js
export function add(a, b) {
  return a + b;
}
```

### 2. Patch (`@patch` + `@find`/`@replace`)
Find and replace text in an existing file. Supports **multiple patches** separated by `---` and **multi-line blocks** with `{}`.

**Single-line patches:**
```javascript
// src/config.js
@patch
@find: const PORT = 3000
@replace: const PORT = 8080
---
@find: debug: false
@replace: debug: true
```

**Multi-line patches:**
```javascript
// src/app.js
@patch
@find {
function oldHandler(req, res) {
  res.send('old');
}
}
@replace {
function newHandler(req, res) {
  res.json({ status: 'ok' });
}
}
```

### 3. Insert (`@insert:N`)
Insert lines after line N in an existing file.

```javascript
// src/routes.js
// @insert:5
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
```

### 4. Delete (`@delete:N-M`)
Delete lines N through M in an existing file.

```javascript
// src/old-code.js
// @delete:10-25
```

### 5. Unified Diff
Standard unified diff format is also supported.

---

## Extension Popup Features

Click the extension icon to:
- 📊 **View stats** — files synced, patches applied, errors
- 🔄 **Auto-Sync toggle** — enable/disable automatic syncing
- 🔍 **Dry-Run toggle** — preview changes without writing
- 📌 **Git Backup toggle** — auto-commit before each change
- ⟳ **Scan Now** — manually trigger a page scan
- 📋 **Activity Log** — recent synced files with timestamps

---

## Config File

Create a `.acs.config.json` in your project root for persistent settings:

```json
{
  "gitBackup": true,
  "dryRun": false,
  "blockedPaths": ["node_modules/", ".env", "secrets/"]
}
```

---

## Supported AI Platforms

| Platform | URL | Status |
|----------|-----|--------|
| Claude | claude.ai | ✅ |
| ChatGPT | chat.openai.com / chatgpt.com | ✅ |
| Gemini | gemini.google.com | ✅ |
| DeepSeek | chat.deepseek.com | ✅ |
| Copilot | copilot.microsoft.com | ✅ |
| Grok | grok.x.ai | ✅ |
| Poe | poe.com | ✅ |
| Mistral | chat.mistral.ai | ✅ |
| HuggingFace | huggingface.co/chat | ✅ |

---

## Project Structure

```
synapse/
├── manifest.json          # Chrome extension config (MV3)
├── content.js             # Runs on AI chat pages — watches DOM, extracts code
├── background.js          # Service worker — relays messages, manages badge
├── popup.html             # Extension popup — premium glassmorphic UI
├── popup.js               # Popup logic — stats, toggles, log
├── server.js              # WebSocket server + file writer + git backup
├── package.json
├── generate-icons.js      # Icon generator (run once)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Tips

- 🎯 Use `--output` flag to point at any project: `node server.js --output ~/projects/my-app`
- 💾 Existing files are backed up (`.bak.timestamp`) before overwriting
- 📌 Enable `--git` for git-based backup (auto-commits before changes)
- 🔍 Use `--dry-run` to preview what would be written
- 📦 Code is buffered in the extension if the server isn't running yet
- 🌍 Works with any programming language
- ⚡ Auto-reconnects with exponential backoff if server restarts
