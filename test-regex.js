// Simplified test — just print key results one per line
const code = `<!-- Find this: -->
<h1>
    Hi, I'm Alex

<!-- Replace with: -->
<h1>
    Hi, I'm Ketan`;

const lines = code.split('\n').map(l => l.trim()).filter(l => l.length > 0);
const patterns = [
    [/^(?:\/\/|#|--)\s+([\w][\w/\\\-.]*\.\w{1,10})(?:\s.*)?$/, 'comment'],
    [/^\/\*\s*([\w][\w/\\\-.]*\.\w{1,10})\s*\*\/$/, 'block-comment'],
    [/^<!--\s*([\w][\w/\\\-.]*\.\w{1,10})\s*-->$/, 'html-comment'],
];

let fnResult = null;
for (let i = 0; i < Math.min(lines.length, 5); i++) {
    for (const [pat, name] of patterns) {
        const m = lines[i].match(pat);
        if (m) {
            console.log("PROBLEM: Line " + i + " '" + lines[i] + "' matched " + name + " => " + m[1]);
            fnResult = m[1];
        }
    }
}
console.log("extractFilenameFromComment result: " + fnResult);

// Check if "Find" text accidentally matches as a filename
const dashPat = /^(?:\/\/|#|--)\s+([\w][\w/\\\-.]*\.\w{1,10})(?:\s.*)?$/;
console.log("Dash match test: " + JSON.stringify("<!-- Find this: -->".match(dashPat)));
