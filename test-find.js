const code = `
<!-- Find this: -->
<h1>
  Hi, I'm Alex

<!-- Replace with: -->
<h1>
  Hi, I'm Ketan

<!-- Find this: -->
Made with <span>♥</span> by Alex
<!-- Replace with: -->
Made with <span>♥</span> by Ketan
`;

function parseFindReplace(body) {
    const blocks = [];
    // Matches variations of:  // Find this:, <!-- Find this: -->, /* Find this: */, # Find this:
    // And the Replace counterpart.
    const regex = /(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*Find (?:this|code)[^]*?:\s*(?:-->|\*\/)?\s*\n)([\s\S]*?)(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*Replace (?:with|code)[^]*?:\s*(?:-->|\*\/)?\s*\n)([\s\S]*?)(?=(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*Find (?:this|code)[^]*?:)|$)/gi;

    let m;
    while ((m = regex.exec(body)) !== null) {
        blocks.push({ find: m[1].trim(), replace: m[2].trim() });
    }
    return blocks;
}

console.log(parseFindReplace(code));
