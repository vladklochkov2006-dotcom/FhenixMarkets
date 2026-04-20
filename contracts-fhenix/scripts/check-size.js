const fs = require('fs');
const artifact = JSON.parse(fs.readFileSync('artifacts/contracts/FhenixMarkets.sol/FhenixMarkets.json', 'utf8'));
const bytecode = artifact.deployedBytecode;
console.log('Deployed Bytecode Length:', (bytecode.length - 2) / 2, 'bytes');
if ((bytecode.length - 2) / 2 > 24576) {
    console.log('WARNING: Exceeds 24.5 KB limit!');
} else {
    console.log('Fits within EVM limit.');
}
