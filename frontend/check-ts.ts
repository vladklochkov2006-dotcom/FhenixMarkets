import { ethers, Contract } from "ethers";

const RPC_URL = "https://ethereum-sepolia.publicnode.com";
const NEW_MARKETS = "0x3B054d0edB8C27020AE370831B360a02DC6DFe8C";

const ABI = [
    "function MARKET_STATUS_ACTIVE() view returns (uint8)",
    "function MIN_LIQUIDITY() view returns (uint128)",
    "function marketCount() view returns (uint256)"
];

async function main() {
    console.log("Connecting to Sepolia RPC...");
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    console.log("Fetching latest block...");
    const block = await provider.getBlock("latest");
    console.log("Block timestamp:", block?.timestamp, "=", new Date(Number(block?.timestamp) * 1000).toLocaleString());

    const contract = new Contract(NEW_MARKETS, ABI, provider);

    const status = await contract.MARKET_STATUS_ACTIVE();
    const minLiq = await contract.MIN_LIQUIDITY();
    const count = await contract.marketCount();

    console.log("\n=== New FhenixMarkets Contract ===");
    console.log("Address:", NEW_MARKETS);
    console.log("MARKET_STATUS_ACTIVE:", status.toString());
    console.log("MIN_LIQUIDITY:", ethers.formatEther(minLiq), "ETH");
    console.log("Market count:", count.toString());
    console.log("\nContract is LIVE and responding!");
}
main().catch(console.error);
