# ⚡ Synapse

**The neural link between AI and your codebase.**

Reads code blocks from AI chats and automatically creates, writes, updates, and patches files in your local project — like Claude Code, but for any AI.

Works with **Claude**, **ChatGPT**, **Gemini**, **DeepSeek**, **Copilot**, **Grok**, **Poe**, **Mistral**, and **HuggingFace Chat**.

```
[Any AI Chat Tab] → [Chrome Extension] → [WebSocket] → [Local Server] → [Your Files]
```

---

## Setup

### Step 1 — Run the Local Server

```bash
npm install
node server.js --output /path/to/your/project
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--output <dir>` | current dir | Target project directory |
| `--port <num>` | `3131` | WebSocket port |
| `--git` | off | Auto git-commit before each file write |
| `--dry-run` | off | Preview changes without writing anything |

### Step 2 — Install the Chrome Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer Mode** (top right toggle)
3. Click **"Load unpacked"** → select this folder
4. Open any supported AI chat — the extension connects automatically

---

## How It Works

1. Chat with any AI and ask it to write or edit code
2. The extension watches the page in real-time via DOM observers
3. When the AI finishes generating, code blocks are extracted and sent over WebSocket
4. The server writes, patches, or creates the file in your project directory

Filenames are detected automatically using a 4-method chain:
1. **Code fence attributes** — ` ```tsx src/Button.tsx `
2. **First-line comments** — `// src/Button.tsx`, `# utils/helper.py`, etc.
3. **DOM labels** — headings or labels near the code block
4. **Conversation context** — surrounding text in the AI chat
5. **File tree matching** — if ambiguous, matches against your project's actual file list

---

## Write Modes

### Overwrite (default)
Writes the entire file. Creates directories as needed.

```javascript
// src/utils/math.js
export function add(a, b) {
  return a + b;
}
```

### SEARCH/REPLACE
Standard search-and-replace diff format. Applied with fuzzy whitespace matching.

```
<<<<<<< SEARCH
function oldName() {
=======
function newName() {
>>>>>>> REPLACE
```

### Smart Patch
Code blocks containing `// ...existing code...` or `# ...existing code...` markers are detected as partial updates. Only the changed sections are applied, leaving the rest of the file intact.

```javascript
// src/app.js
function setup() {
  // ...existing code...
  newFeature(); // ← only this line gets added
  // ...existing code...
}
```

---

## Config File

Create a `.synapse.config.json` in your project root for persistent settings (`.acs.config.json` also supported for backwards compatibility):

```json
{
  "gitBackup": true,
  "dryRun": false,
  "blockedPaths": ["node_modules/", ".env", "secrets/"]
}
```

---

## Popup

Click the extension icon to see:
- **Connection status** — connected/disconnected indicator
- **Target directory** — which project the server is writing to
- **Stats** — files created, updated, patches applied, errors
- **Activity log** — recent operations with timestamps and mode labels

---

## Supported AI Platforms

| Platform | URL |
|----------|-----|
| Claude | claude.ai |
| ChatGPT | chat.openai.com / chatgpt.com |
| Gemini | gemini.google.com |
| DeepSeek | chat.deepseek.com |
| Copilot | copilot.microsoft.com |
| Grok | grok.x.ai |
| Poe | poe.com |
| Mistral | chat.mistral.ai |
| HuggingFace | huggingface.co/chat |

---

## Project Structure

```
synapse/
├── manifest.json        # Chrome extension config (MV3)
├── content.js           # Runs on AI chat pages — watches DOM, extracts code
├── background.js        # Service worker — relays messages, manages badge
├── popup.html           # Extension popup UI
├── popup.js             # Popup logic — stats, toggles, activity log
├── server.js            # WebSocket server + file writer + git backup
├── package.json
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Tips

- Point at any project: `node server.js --output ~/projects/my-app`
- Use `--git` to auto-commit before every change (safe rollback)
- Use `--dry-run` to preview what would be written without touching files
- The extension auto-reconnects with exponential backoff if the server restarts
- Works with any programming language
