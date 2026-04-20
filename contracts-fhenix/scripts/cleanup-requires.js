const fs = require('fs');
let content = fs.readFileSync('contracts/FhenixMarkets.sol', 'utf8');
// Replace require(cond, "...") with require(cond)
content = content.replace(/require\(([^,]+),\s*".*?"\)/g, 'require($1)');
fs.writeFileSync('contracts/FhenixMarkets.sol', content);
console.log('Cleaned up require statements.');
