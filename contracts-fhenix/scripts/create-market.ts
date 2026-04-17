// Script to:
// 1. Create a market on-chain with a valid future deadline
// 2. Register it in Supabase
// 3. Delete all old (expired/broken) markets from Supabase
import { ethers } from "hardhat";
import { createClient } from "@supabase/supabase-js";

const MARKETS_ADDRESS = "0x3B054d0edB8C27020AE370831B360a02DC6DFe8C";
const SUPABASE_URL = "https://nwpzbuztlqypejbeyxla.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im53cHpidXp0bHF5cGVqYmV5eGxhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3OTk3MjksImV4cCI6MjA5MDM3NTcyOX0.LImNELAPf_eH6Up_WE39rUPr9cgeSak6Tv9sPT2fJC4";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Using account:", deployer.address);
    console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

    // === STEP 1: Delete old markets from Supabase ===
    console.log("\n--- Cleaning up old Supabase entries ---");
    const { data: oldMarkets, error: listErr } = await supabase
        .from("market_registry")
        .select("market_id, question_text");

    if (listErr) {
        console.error("Failed to list markets:", listErr.message);
    } else {
        console.log(`Found ${oldMarkets?.length || 0} old Supabase entries to delete`);
        if (oldMarkets && oldMarkets.length > 0) {
            const { error: delErr } = await supabase
                .from("market_registry")
                .delete()
                .neq("market_id", "none"); // delete all
            if (delErr) console.error("Delete error:", delErr.message);
            else console.log("All old markets deleted from Supabase ✓");
        }
    }

    // === STEP 2: Create new market on-chain ===
    const question = "Will Ethereum (ETH) reach $5,000 before the end of 2026?";
    const questionHash = ethers.keccak256(ethers.toUtf8Bytes(question));

    // Current time is ~1776456800 (from previous block check)
    // Deadline: 30 days from now
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + 30 * 24 * 60 * 60);         // +30 days
    const resolutionDeadline = BigInt(now + 37 * 24 * 60 * 60); // +37 days

    const initialLiquidityWei = ethers.parseEther("0.01"); // 0.01 ETH

    console.log("\n--- Creating market on-chain ---");
    console.log("Question:", question);
    console.log("Deadline:", new Date(Number(deadline) * 1000).toLocaleString());
    console.log("Resolution:", new Date(Number(resolutionDeadline) * 1000).toLocaleString());
    console.log("Liquidity: 0.01 ETH");

    const FhenixMarkets = await ethers.getContractFactory("FhenixMarkets");
    const contract = FhenixMarkets.attach(MARKETS_ADDRESS);

    const tx = await (contract as any).createMarket(
        questionHash,
        0,  // category: Crypto
        2,  // numOutcomes
        deadline,
        resolutionDeadline,
        ethers.ZeroAddress,
        { value: initialLiquidityWei }
    );

    console.log("TX sent:", tx.hash);
    const receipt = await tx.wait();
    console.log("Confirmed in block:", receipt.blockNumber);

    // Parse MarketCreated event
    const marketCreatedTopic = ethers.id("MarketCreated(bytes32,address,bytes32,uint8,uint64)");
    const log = receipt.logs.find((l: any) => l.topics[0] === marketCreatedTopic);
    const marketId = log?.topics[1] || questionHash;

    console.log("\n✅ Market created!");
    console.log("Market ID:", marketId);
    console.log("TX hash:", receipt.hash);

    // === STEP 3: Save to Supabase ===
    console.log("\n--- Saving to Supabase ---");
    const { error: insertErr } = await supabase.from("market_registry").insert({
        market_id: marketId,
        question_hash: questionHash,
        question_text: question,
        description: "The market resolves YES if ETH spot price is at or above $5,000 on any major exchange before December 31, 2026 UTC.",
        category: 0,
        creator_address: deployer.address,
        created_at: Date.now(),
        outcome_labels: JSON.stringify(["Yes", "No"]),
        num_outcomes: 2,
        deadline: Number(deadline) * 1000,
        resolution_deadline: Number(resolutionDeadline) * 1000,
        status: 1,
        token_type: "ETH",
        initial_liquidity: 0.01,
        transaction_id: receipt.hash,
        resolution_source: "CoinGecko, Binance spot price",
    });

    if (insertErr) {
        console.error("Supabase insert failed:", insertErr.message);
    } else {
        console.log("✅ Market saved to Supabase!");
    }

    console.log("\n========================================");
    console.log("DONE! New market is live.");
    console.log("Market ID:", marketId);
    console.log("========================================");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
