import { createClient } from '@supabase/supabase-js'

// Try to use the variables from .env
import * as dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://nwpzbuztlqypejbeyxla.supabase.co';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY!;

if (!supabaseAnonKey) {
    console.error("Missing VITE_SUPABASE_ANON_KEY in .env");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function main() {
    console.log("Supabase URL:", supabaseUrl);

    const testMarketId = "0x" + Math.random().toString(16).slice(2) + "0000000000000000000000000000000000000000";

    const entry = {
        market_id: testMarketId,
        question_hash: "0xtest",
        question_text: "Will Supabase integration work in May 2026?",
        category: 1,
        creator_address: "0xd5C9B9a6E16112B8985280c07462E3b358C3844F",
        created_at: Date.now(),
        num_outcomes: 2,
        status: 1
    };

    console.log("1. Testing insert...");
    const { error: insertError } = await supabase
        .from('market_registry')
        .upsert([entry], { onConflict: 'market_id' });

    if (insertError) {
        console.error("Insert failed:", insertError);
        process.exit(1);
    }
    console.log("Insert successful!");

    console.log("2. Testing fetch...");
    const { data, error: fetchError } = await supabase
        .from('market_registry')
        .select('*')
        .eq('market_id', testMarketId);

    if (fetchError) {
        console.error("Fetch failed:", fetchError);
        process.exit(1);
    }

    console.log("Fetch successful! Returned data length:", data?.length);
    if (data && data.length > 0) {
        console.log("Sample Data object text:", data[0].question_text);
    }

    // Cleanup
    await supabase.from('market_registry').delete().eq('market_id', testMarketId);
    console.log("Cleanup successful");
}

main().catch(console.error);
