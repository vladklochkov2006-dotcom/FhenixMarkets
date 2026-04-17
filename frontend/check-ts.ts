// Manually insert the market that was already created on-chain
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://nwpzbuztlqypejbeyxla.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im53cHpidXp0bHF5cGVqYmV5eGxhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3OTk3MjksImV4cCI6MjA5MDM3NTcyOX0.LImNELAPf_eH6Up_WE39rUPr9cgeSak6Tv9sPT2fJC4";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const MARKET = {
    market_id: "0x026223796fea46df6d370394228af21ba3860558e4e3c0a22f3e397b7245b8a6",
    question_hash: "0x61a3e5d21e30d62d96dbf3e9d63e2fd9ecda3a98c1ec5d1d2b2f6879db897a9c",
    question_text: "Will Ethereum (ETH) reach $5,000 before December 31, 2026?",
    description: "Resolves YES if ETH spot price on any major exchange is at or above $5,000 at any point before December 31, 2026 UTC.",
    category: 0,
    creator_address: "0xd5C9B9a6E16112B8985280c07462E3b358C3844F",
    created_at: Date.now(),
    outcome_labels: JSON.stringify(["Yes", "No"]),
    num_outcomes: 2,
    // block.timestamp was 1776457236, deadline = +30 days
    deadline: (1776457236 + 30 * 24 * 60 * 60) * 1000,           // 17.05.2026 in ms
    resolution_deadline: (1776457236 + 37 * 24 * 60 * 60) * 1000, // 24.05.2026 in ms
    status: 1,
    token_type: "ETH",
    initial_liquidity: 1000000, // stored as integer (microeth or just 0.01 ETH * 1e8)
    transaction_id: "0x91bf458a7d1f11a2e2b3576a502dd464930b4a2f09b6fa058588cefd57c4881f",
    resolution_source: "CoinGecko / Binance spot price",
};

async function main() {
    // First try to check the column type by fetching an existing row
    const { data: sample, error: sampleErr } = await supabase
        .from("market_registry")
        .select("initial_liquidity")
        .limit(1);

    if (sampleErr) console.log("No existing rows, proceeding with insert");
    else console.log("Sample initial_liquidity type hint:", typeof sample?.[0]?.initial_liquidity);

    // Try insert with numeric initial_liquidity
    const { error } = await supabase.from("market_registry").insert({
        ...MARKET,
        initial_liquidity: 1000000, // try as integer (bigint)
    });

    if (error) {
        console.error("Integer insert failed:", error.message);
        // Try without initial_liquidity
        const { error: e2 } = await supabase.from("market_registry").insert({
            ...MARKET,
            initial_liquidity: undefined,
        });
        if (e2) console.error("No-liquidity insert also failed:", e2.message);
        else console.log("✅ Inserted without initial_liquidity!");
    } else {
        console.log("✅ Market inserted into Supabase successfully!");
    }
}

main().catch(console.error);
