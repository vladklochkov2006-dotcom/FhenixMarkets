// Run: npx tsx create-market.ts
// Creates a market on-chain and registers it in Supabase, deletes old entries.
import { ethers, Contract } from "ethers";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const RPC_URL = "https://ethereum-sepolia.publicnode.com";
const MARKETS_ADDRESS = "0x3B054d0edB8C27020AE370831B360a02DC6DFe8C";
const SUPABASE_URL = "https://nwpzbuztlqypejbeyxla.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im53cHpidXp0bHF5cGVqYmV5eGxhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3OTk3MjksImV4cCI6MjA5MDM3NTcyOX0.LImNELAPf_eH6Up_WE39rUPr9cgeSak6Tv9sPT2fJC4";

// Load private key from contracts-fhenix .env or environment
const envPath = path.join("..", "contracts-fhenix", ".env");
let privateKey = process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey && fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    const match = envContent.match(/(?:PRIVATE_KEY|DEPLOYER_PRIVATE_KEY)\s*=\s*(.+)/);
    privateKey = match?.[1]?.trim();
}
if (!privateKey) {
    throw new Error("No PRIVATE_KEY found! Set PRIVATE_KEY environment variable or create contracts-fhenix/.env");
}

// Load ABI
const abiPath = path.join("src", "lib", "abis", "FhenixMarkets.json");
const artifact = JSON.parse(fs.readFileSync(abiPath, "utf8"));
const ABI = artifact.abi;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(privateKey!, provider);

    const block = await provider.getBlock("latest");
    console.log("block.timestamp:", block?.timestamp, "→", new Date(Number(block?.timestamp) * 1000).toLocaleString());
    console.log("Wallet:", wallet.address);
    console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH");

    // === 1. Delete old Supabase entries ===
    console.log("\n--- Cleaning old Supabase entries ---");
    const { data: old, error: listErr } = await supabase.from("market_registry").select("market_id");
    if (listErr) console.error("List error:", listErr.message);
    else if (old && old.length > 0) {
        const ids = old.map((r: any) => r.market_id);
        const { error: delErr } = await supabase.from("market_registry").delete().in("market_id", ids);
        if (delErr) console.error("Delete error:", delErr.message);
        else console.log(`Deleted ${ids.length} old market(s) from Supabase ✓`);
    } else {
        console.log("No old markets to delete");
    }

    // === 2. Create market on-chain ===
    const question = "Will Ethereum (ETH) reach $5,000 before December 31, 2026?";
    const questionHash = ethers.keccak256(ethers.toUtf8Bytes(question));
    const now = Number(block!.timestamp);

    const deadline = BigInt(now + 30 * 24 * 60 * 60);           // +30 days
    const resolutionDeadline = BigInt(now + 37 * 24 * 60 * 60); // +37 days
    const initialLiquidityWei = ethers.parseEther("0.01");

    console.log("\n--- Creating market on-chain ---");
    console.log("Question:", question);
    console.log("Deadline:", new Date(Number(deadline) * 1000).toLocaleDateString());
    console.log("Resolution:", new Date(Number(resolutionDeadline) * 1000).toLocaleDateString());

    const contract = new Contract(MARKETS_ADDRESS, ABI, wallet);
    const tx = await (contract as any).createMarket(
        questionHash,
        0,                    // category: Crypto
        2,                    // numOutcomes: Yes/No
        deadline,
        resolutionDeadline,
        ethers.ZeroAddress,   // no specific resolver
        { value: initialLiquidityWei }
    );

    console.log("TX sent:", tx.hash);
    const receipt = await tx.wait();
    console.log("Confirmed ✓  block:", receipt.blockNumber);

    // Parse MarketCreated event: MarketCreated(bytes32 indexed marketId, address indexed creator, bytes32 questionHash, uint8 numOutcomes, uint64 deadline)
    const marketCreatedTopic = ethers.id("MarketCreated(bytes32,address,bytes32,uint8,uint64)");
    const log = receipt.logs.find((l: any) => l.topics[0] === marketCreatedTopic);
    const marketId = log?.topics[1] || questionHash;
    console.log("Market ID:", marketId);

    // === 3. Register in Supabase ===
    console.log("\n--- Saving to Supabase ---");
    const { error: insertErr } = await supabase.from("market_registry").insert({
        market_id: marketId,
        question_hash: questionHash,
        question_text: question,
        description: "Resolves YES if ETH spot price on any major exchange is at or above $5,000 at any point before December 31, 2026 UTC.",
        category: 0,
        creator_address: wallet.address,
        created_at: Date.now(),
        outcome_labels: JSON.stringify(["Yes", "No"]),
        num_outcomes: 2,
        deadline: Number(deadline) * 1000,
        resolution_deadline: Number(resolutionDeadline) * 1000,
        status: 1,
        token_type: "ETH",
        initial_liquidity: 0.01,
        transaction_id: receipt.hash,
        resolution_source: "CoinGecko / Binance spot price",
    });

    if (insertErr) {
        console.error("❌ Supabase insert failed:", insertErr.message);
    } else {
        console.log("✅ Market saved to Supabase!");
    }

    console.log("\n=== SUCCESS ===");
    console.log("Market:", question);
    console.log("ID:", marketId);
    console.log("TX:", receipt.hash);
    console.log("Expires:", new Date(Number(deadline) * 1000).toLocaleDateString());
}

main().catch((e) => { console.error(e); process.exit(1); });
