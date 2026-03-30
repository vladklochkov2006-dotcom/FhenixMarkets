// ============================================================================
// FHENIX MARKETS — Market Store (Supabase-first)
// ============================================================================
// Fetches market data from Supabase market_registry.
// When smart contracts are deployed, this will also pull on-chain state.
// ============================================================================

import { create } from 'zustand'
import type { Market } from './store'
import { fetchMarketRegistry, fetchBetCountsForMarkets, type MarketRegistryEntry } from './supabase'
import { devLog } from './logger'

interface MarketsState {
    markets: Market[]
    isLoading: boolean
    isRefreshing: boolean
    error: string | null
    lastFetchTime: number | null
}

interface MarketsActions {
    fetchMarkets: () => Promise<void>
    addMarket: (marketId: string) => Promise<void>
    refreshMarket: (marketId: string) => Promise<void>
}

type MarketsStore = MarketsState & MarketsActions

/**
 * Convert a Supabase MarketRegistryEntry to a Market object.
 * Provides sensible defaults for fields that will come from smart contracts later.
 */
function registryEntryToMarket(entry: MarketRegistryEntry): Market {
    const outcomeLabels = entry.outcome_labels
        ? (() => { try { return JSON.parse(entry.outcome_labels) } catch { return ['Yes', 'No'] } })()
        : ['Yes', 'No']
    const numOutcomes = entry.num_outcomes || outcomeLabels.length || 2

    const now = Date.now()
    const deadline = entry.deadline || (now + 7 * 24 * 60 * 60 * 1000) // default 7 days
    const resolutionDeadline = entry.resolution_deadline || (deadline + 3 * 24 * 60 * 60 * 1000)
    const isExpired = now > deadline
    const status = entry.status || (isExpired ? 2 : 1) // 1=active, 2=closed

    // Calculate time remaining
    let timeRemaining: string | undefined
    if (status === 1) {
        const diff = deadline - now
        if (diff > 0) {
            const days = Math.floor(diff / (24 * 60 * 60 * 1000))
            const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
            timeRemaining = days > 0 ? `${days}d ${hours}h` : `${hours}h`
        } else {
            timeRemaining = 'Expired'
        }
    }

    // Default liquidity (will come from smart contract later)
    const liquidity = BigInt(entry.initial_liquidity || 1000_000000)

    return {
        id: entry.market_id,
        question: entry.question_text || 'Untitled Market',
        description: entry.description,
        category: entry.category || 0,
        numOutcomes,
        outcomeLabels,
        deadline: BigInt(deadline),
        resolutionDeadline: BigInt(resolutionDeadline),
        status,

        // AMM defaults (50/50 initial odds)
        yesReserve: liquidity / 2n,
        noReserve: liquidity / 2n,
        reserve3: 0n,
        reserve4: 0n,
        totalLiquidity: liquidity,
        totalLPShares: liquidity,

        yesPrice: 0.5,
        noPrice: 0.5,

        yesPercentage: 50,
        noPercentage: 50,
        totalVolume: 0n,
        totalBets: 0,

        totalYesIssued: 0n,
        totalNoIssued: 0n,

        potentialYesPayout: 2.0,
        potentialNoPayout: 2.0,

        creator: entry.creator_address,
        timeRemaining,
        deadlineTimestamp: deadline,
        resolutionSource: entry.resolution_source,
        transactionId: entry.transaction_id,
        tokenType: 'ETH',
        thumbnailUrl: entry.thumbnail_url,
    }
}

export const useRealMarketsStore = create<MarketsStore>((set, get) => ({
    markets: [],
    isLoading: false,
    isRefreshing: false,
    error: null,
    lastFetchTime: null,

    fetchMarkets: async () => {
        const currentMarkets = get().markets
        const isInitialLoad = currentMarkets.length === 0

        if (isInitialLoad) {
            set({ isLoading: true, error: null })
        } else {
            set({ isRefreshing: true, error: null })
        }

        try {
            // Fetch markets from Supabase
            const registryEntries = await fetchMarketRegistry()

            // Filter out pending entries
            const validEntries = registryEntries.filter(e => !e.market_id.startsWith('pending_'))

            // Transform to Market objects
            const markets = validEntries.map(registryEntryToMarket)

            devLog(`[Markets] Loaded ${markets.length} markets from Supabase`)

            // Merge with existing to preserve object identity
            const prevMap = new Map(get().markets.map(m => [m.id, m]))
            const mergedMarkets = markets.map(m => {
                const prev = prevMap.get(m.id)
                if (!prev) return m
                if (
                    prev.status === m.status &&
                    prev.question === m.question &&
                    prev.totalBets === m.totalBets
                ) {
                    return prev
                }
                return { ...prev, ...m, totalBets: prev.totalBets || m.totalBets }
            })

            set({
                markets: mergedMarkets,
                isLoading: false,
                isRefreshing: false,
                lastFetchTime: Date.now(),
            })

            // Hydrate bet counts (non-blocking)
            const marketIds = markets.map(m => m.id)
            fetchBetCountsForMarkets(marketIds).then(counts => {
                if (Object.keys(counts).length === 0) return
                set(state => ({
                    markets: state.markets.map(m => ({
                        ...m,
                        totalBets: counts[m.id] ?? m.totalBets,
                    }))
                }))
            })
        } catch (error) {
            console.error('Failed to fetch markets:', error)
            set({
                error: error instanceof Error ? error.message : 'Failed to fetch markets',
                isLoading: false,
                isRefreshing: false,
                markets: isInitialLoad ? [] : get().markets,
            })
        }
    },

    addMarket: async (marketId: string) => {
        // Re-fetch all markets to include the new one
        devLog('[Markets] Adding market, re-fetching all:', marketId)
        await get().fetchMarkets()
    },

    refreshMarket: async (_marketId: string) => {
        // Re-fetch all markets
        await get().fetchMarkets()
    },
}))
