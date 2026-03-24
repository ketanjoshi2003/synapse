---
name: Synapse Code Skill
description: How to format code blocks so Synapse can automatically fetch and write them to the codebase. Covers all write modes, filename conventions, and best practices.
---

# Synapse Code Skill

> **Synapse** is the neural link between AI and your codebase.
> It reads code blocks from AI chats and automatically creates, writes, updates, and patches files in your local project.

When the user asks for any coding task — creating files, editing code, fixing bugs, adding features — you **MUST** follow these formatting rules so Synapse can detect, extract, and write the code to their project automatically.

---

## Core Rule: Always Include the Filename

Every code block you produce **must** include a filename so Synapse knows where to write it. There are two supported methods:

### Method 1 — First-Line Comment (Preferred)

Place the file path as a comment on the **very first line** of the code block, using the language's native comment syntax:

```javascript
// src/utils/math.js
export function add(a, b) {
  return a + b;
}
```

```python
# utils/helpers.py
def greet(name):
    return f"Hello, {name}!"
```

```html
<!-- templates/header.html -->
<header>
  <h1>My App</h1>
</header>
```

```css
/* styles/main.css */
body {
  margin: 0;
  font-family: 'Inter', sans-serif;
}
```

```sql
-- migrations/001_create_users.sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);
```

### Method 2 — Code Fence Info String

Append the filename after the language identifier with a colon:

````
```typescript:src/app.ts
export const app = express();
```
````

---

## Write Modes

Synapse supports multiple write modes. Choose the right one based on the task:

### 1. Overwrite (Default)

Writes the **entire file**. Creates directories as needed. Use when you're providing the **complete file contents**.

```javascript
// src/utils/math.js
export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}
```

**When to use:**
- Creating new files
- Rewriting entire files
- When the full file content is provided

---

### 2. SEARCH/REPLACE

Standard search-and-replace diff format. Applied with **fuzzy whitespace matching**. Best for precise, targeted edits to existing files.

```
// src/utils/math.js
<<<<<<< SEARCH
function oldName() {
  return 'old';
}
=======
function newName() {
  return 'new';
}
>>>>>>> REPLACE
```

**Multiple edits in one block:**

```
// src/app.js
<<<<<<< SEARCH
const PORT = 3000;
=======
const PORT = process.env.PORT || 3000;
>>>>>>> REPLACE

<<<<<<< SEARCH
app.listen(PORT);
=======
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
>>>>>>> REPLACE
```

**When to use:**
- Renaming functions, variables, or classes
- Changing specific values or logic
- Making multiple precise edits to different parts of a file
- When you need exact control over what changes

---

### 3. Smart Patch

Code blocks containing `// ...existing code...` or `# ...existing code...` markers are detected as **partial updates**. Only the changed sections are applied, leaving the rest of the file intact.

```javascript
// src/app.js
function setup() {
  // ...existing code...
  newFeature(); // ← only this line gets added
  // ...existing code...
}
```

```python
# src/config.py
class Config:
    # ...existing code...
    NEW_SETTING = True  # ← added
    # ...existing code...
```

**Supported marker variations:**
- `// ...existing code...`
- `# ...existing code...`
- `/* ...existing code... */`
- `<!-- ...existing code... -->`
- `// ...rest of the file...`
- `# ...remaining code...`
- `...` (bare ellipsis on its own line)

**When to use:**
- Adding a few lines to a large file
- When you only need to show the changed function/section
- When the full file would be too verbose

---

### 4. Insert at Line

Insert code after a specific line number using the `@insert` directive:

```javascript
// src/routes.js
// @insert:15
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});
```

---

### 5. Delete Lines

Remove a range of lines using the `@delete` directive:

```javascript
// src/old-module.js
// @delete:10-25
```

---

## Best Practices

### ✅ DO

1. **Always start with the filename** — every code block needs a path
2. **Use forward slashes** in paths: `src/utils/math.js` (not backslashes)
3. **Use relative paths** from the project root: `src/app.js`, `lib/helpers.py`
4. **Use SEARCH/REPLACE** for small, targeted edits to existing files
5. **Use Smart Patch** when adding to large files where full content is unnecessary
6. **Use Overwrite** when creating new files or providing complete replacements
7. **Group related changes** — if editing multiple files, provide each as a separate code block
8. **Match the existing code style** — indentation, quotes, semicolons, etc.

### ❌ DON'T

1. **Don't omit the filename** — Synapse will skip blocks without a detectable filename
2. **Don't use partial snippets without markers** — if you show only part of a file, use `// ...existing code...` markers or SEARCH/REPLACE
3. **Don't use `...` casually inside actual code** — Synapse may misinterpret it as a truncation marker
4. **Don't wrap filenames in extra formatting** — just a clean path: `src/app.js`
5. **Don't use blocked filenames** — `manifest.json`, `content.js`, `background.js`, `popup.js`, `popup.html`, `package-lock.json` are protected by Synapse

---

## Multi-File Tasks

When a task involves multiple files, provide **one code block per file**, each with its own filename:

```javascript
// src/models/User.js
export class User {
  constructor(name, email) {
    this.name = name;
    this.email = email;
  }
}
```

```javascript
// src/routes/users.js
import { User } from '../models/User.js';

export function getUsers(req, res) {
  // handler logic
}
```

```css
/* src/styles/users.css */
.user-card {
  padding: 1rem;
  border-radius: 8px;
  background: #f8fafc;
}
```

---

## Choosing the Right Write Mode — Decision Guide

| Scenario | Mode | Why |
|----------|------|-----|
| Brand new file | **Overwrite** | File doesn't exist yet |
| Complete rewrite | **Overwrite** | Replacing the entire file |
| Rename a function | **SEARCH/REPLACE** | Precise, targeted change |
| Fix a bug on one line | **SEARCH/REPLACE** | Exact match + replacement |
| Add a route to a large Express app | **Smart Patch** | Only show the new route + existing code markers |
| Add an import to the top of a file | **Smart Patch** | Small addition, keep everything else |
| Multiple targeted edits across a file | **SEARCH/REPLACE** | Multiple find/replace blocks in one code block |
| Add lines at a specific position | **Insert** | Know the exact line number |
| Remove deprecated code | **Delete** | Know the line range to remove |

---

## Language-Specific Comment Syntax for Filenames

| Language | Comment Style |
|----------|--------------|
| JavaScript / TypeScript / Java / C / C++ / C# / Go / Rust / Swift / Kotlin / Dart | `// path/file.ext` |
| Python / Ruby / Bash / YAML / TOML / Dockerfile | `# path/file.ext` |
| HTML / XML / SVG | `<!-- path/file.ext -->` |
| CSS / SCSS / LESS | `/* path/file.ext */` |
| SQL / Lua / Haskell | `-- path/file.ext` |
| Assembly | `; path/file.ext` |
| LaTeX / MATLAB | `% path/file.ext` |
| Batch | `rem path/file.ext` |

---

## Keywords Reference

These keywords are recognized by Synapse in various contexts:

**Write mode markers:**
- `<<<<<<< SEARCH` / `======= ` / `>>>>>>> REPLACE` — SEARCH/REPLACE mode
- `// ...existing code...` / `# ...existing code...` — Smart Patch mode
- `// @insert:<line>` — Insert mode
- `// @delete:<from>-<to>` — Delete mode
- `@find` / `@replace` — Patch mode (legacy)

**Filename prefix keywords:**
- `// file:`, `# file:`, `// path:`, `// filename:` — explicit filename declarations

**Truncation markers (trigger Smart Patch):**
- `// ...existing code...`, `# ...remaining code...`
- `// (rest remains the same)`, `# unchanged below`
- `// ...rest of the file...`, `/* ...existing code... */`
- `<!-- ... -->` (HTML ellipsis)
- Bare `...` or `…` on its own line

---

## Example: Complete Feature Implementation

**User asks:** "Add a health check endpoint to my Express app"

### Response format:

First, add the route handler:

```javascript
// src/routes/health.js
export function healthCheck(req, res) {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
}
```

Then register it in the main app:

```javascript
// src/app.js
<<<<<<< SEARCH
import { userRoutes } from './routes/users.js';
=======
import { userRoutes } from './routes/users.js';
import { healthCheck } from './routes/health.js';
>>>>>>> REPLACE

<<<<<<< SEARCH
app.use('/api/users', userRoutes);
=======
app.use('/api/users', userRoutes);
app.get('/api/health', healthCheck);
>>>>>>> REPLACE
```

---

## Fetching Code from the Codebase

Synapse connects to a local WebSocket server that has access to your project's file tree. When you need to reference existing files, ask the user about the current file contents — Synapse will provide the file tree and can serve individual file contents when requested through the extension popup.

The server exposes:
- **`FILE_TREE`** — the complete list of files in the project (excluding `node_modules`, `.git`, etc.)
- **`FILE_CONTENT`** — read a specific file's contents (up to 500KB)

This allows you to understand the project structure and write code that integrates seamlessly.

---

## Summary

1. **Every code block = one file** — always include the filename as a first-line comment
2. **New file → Overwrite** — provide full contents
3. **Small edit → SEARCH/REPLACE** — precise find-and-replace
4. **Partial update → Smart Patch** — use `// ...existing code...` markers
5. **Follow the decision guide** to pick the right mode
6. **Never omit filenames** — unnamed blocks are silently skipped
