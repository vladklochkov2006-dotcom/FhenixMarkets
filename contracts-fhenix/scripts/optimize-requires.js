const fs = require('fs');

let code = fs.readFileSync('contracts/FhenixMarkets.sol', 'utf8');

// Also handle multiline requires but prevent matching across statements
const requireRegex = /require\(\s*([^;"]*?)\s*,\s*"([^"]+)"\s*\);/g;

let match;
const errors = new Map();

while ((match = requireRegex.exec(code)) !== null) {
    const msg = match[2];
    let errorName = 'Err_' + msg.replace(/[^a-zA-Z0-9]/g, '');
    // If it's empty
    if (errorName === 'Err_') errorName = 'Err_Generic';
    errors.set(msg, errorName);
}

// Add Err_Generic just in case
errors.set('Generic', 'Err_Generic');

let errorDecls = Array.from(errors.values()).map(e => `    error ${e}();`).join('\n');

// Remove errorDecls if they already exist (to be safe from multiple runs)
errorDecls = `\n    // Custom Errors for Bytecode Reduction\n` + errorDecls + `\n`;

code = code.replace(/contract FhenixMarkets is ReentrancyGuard {\n/, `contract FhenixMarkets is ReentrancyGuard {\n${errorDecls}`);

// Replace formatting correctly
code = code.replace(/require\(\s*([^;"]*?)\s*,\s*"([^"]+)"\s*\);/g, (match, condition, msg) => {
    let errorName = errors.get(msg);
    return `if (!(${condition})) revert ${errorName}();`;
});

fs.writeFileSync('contracts/FhenixMarkets.sol', code);
console.log("Optimization complete.");
