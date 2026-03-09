const regex = /(?:(?:target|output)\s+)?(?:file\s*name|file|path|filename)\s*[:=]\s*`?([\w][\w/\\\-.]*\.\w{1,10})`?/i;
console.log("Test 1:", "Here's everything you need:File name: portfolio.html".match(regex));
console.log("Test 2:", "File name: portfolio.html".match(regex));
