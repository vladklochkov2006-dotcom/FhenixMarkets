import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  walletManager,
  fetchPublicBalance,

  lookupWalletTransactionStatus,
  type WalletType,
  type NetworkType,
  type WalletAccount,
  type WalletBalance,
} from './wallet'
import {
  FHENIX_MARKETS_ADDRESS,
  fetchMarket as fetchMarketFromChain,
  fetchVoteTally,
} from './contracts'
import { config } from './config'
import { devLog, devWarn } from './logger'
import {
  isSupabaseAvailable, fetchBets as sbFetchBets, upsertBets as sbUpsertBets,
  fetchPendingBets as sbFetchPendingBets, upsertPendingBets as sbUpsertPendingBets,
  removePendingBet as sbRemovePendingBet, removeUserBet as sbRemoveUserBet,
  fetchCommitments as sbFetchCommitments, upsertCommitments as sbUpsertCommitments,
} from './supabase'

// ============================================================================
// EVM contract interaction stubs
// ============================================================================

/** Legacy CONTRACT_INFO stub — provides programId for code that still references it */
export const CONTRACT_INFO = {
  programId: FHENIX_MARKETS_ADDRESS,
  network: 'sepolia',
  explorerUrl: 'https://sepolia.etherscan.io',
  useMockData: false,
}

/** Returns the markets contract address */
function getProgramIdForToken(_token: string): string {
  return FHENIX_MARKETS_ADDRESS
}

/** Transaction diagnosis stub — not available on EVM */
async function diagnoseTransaction(_txId: string): Promise<{ status: string; error?: string }> {
  return { status: 'unknown', error: 'Transaction diagnosis not available on EVM' }
}

/** Input builder stub — not applicable on EVM */
function buildBuySharesInputs(
  _marketId: string,
  _outcomeNum: number,
  _amount: bigint,
  _expectedShares: bigint,
  _minSharesOut: bigint,
  _tokenType: string,
  _creditsRecord?: string,
): { functionName: string; inputs: string[] } {
  return { functionName: 'buyShares', inputs: [] }
}

/** Reads market data from on-chain contract */
async function getMarket(marketId: string): Promise<{ status: number } | null> {
  const data = await fetchMarketFromChain(marketId)
  if (!data) return null
  return { status: data.status }
}

/** Reads resolution from on-chain contract */
async function getMarketResolution(marketId: string): Promise<{ winning_outcome: number } | null> {
  const tally = await fetchVoteTally(marketId)
  if (!tally || !tally.finalized) return null
  return { winning_outcome: tally.winningOutcome }
}

// ============================================================================
// Types
// ============================================================================

export interface Market {
  id: string
  question: string
  description?: string
  category: number
  numOutcomes: number        // v12: 2, 3, or 4
  outcomeLabels: string[]    // v12: labels for each outcome
  deadline: bigint
  resolutionDeadline: bigint
  status: number // 1=active, 2=closed, 3=resolved, 4=cancelled, 5=pending_resolution

  // AMM Pool Data (v12 - multi-outcome reserves)
  yesReserve: bigint         // reserve_1
  noReserve: bigint          // reserve_2
  reserve3: bigint           // reserve_3 (0 if binary)
  reserve4: bigint           // reserve_4 (0 if binary)
  totalLiquidity: bigint     // Total tokens in pool
  totalLPShares: bigint      // LP tokens in circulation

  yesPrice: number           // Outcome 1 price (0-1)
  noPrice: number            // Outcome 2 price (0-1)

  // Legacy fields (for backward compatibility)
  yesPercentage: number
  noPercentage: number
  totalVolume: bigint
  totalBets: number

  // Issued shares
  totalYesIssued: bigint
  totalNoIssued: bigint

  // Payout calculations
  potentialYesPayout: number
  potentialNoPayout: number

  // v12: Resolution with challenge window
  challengeDeadline?: bigint
  finalized?: boolean

  // Remaining collateral after winner claims (only for resolved/cancelled markets)
  remainingCredits?: bigint

  creator?: string
  resolver?: string
  timeRemaining?: string
  deadlineTimestamp?: number  // Estimated deadline as unix ms (for live countdown)
  resolutionSource?: string
  tags?: string[]
  transactionId?: string
  tokenType?: 'ETH'
  thumbnailUrl?: string
}

export interface SharePosition {
  id: string
  marketId: string
  shareType: 'yes' | 'no'
  quantity: bigint
  avgPrice: number
  currentValue: number
  profitLoss: number
  profitLossPercent: number
  acquiredAt: number
}

export interface Bet {
  id: string
  marketId: string
  amount: bigint
  outcome: string             // 'yes' | 'no' | 'outcome_3' | 'outcome_4' (1-indexed via outcomeToIndex)
  placedAt: number
  status: 'pending' | 'active' | 'won' | 'lost' | 'refunded'
  type?: 'buy' | 'sell'       // Trade type (default 'buy')
  marketQuestion?: string
  lockedMultiplier?: number    // Payout multiplier locked at time of bet
  sharesReceived?: bigint      // Shares received from buy (v19FPMM)
  sharesSold?: bigint          // Shares burned in sell
  tokensReceived?: bigint      // Net tokens received from sell (after fees)
  payoutAmount?: bigint        // Calculated payout when market resolves (won bets)
  winningOutcome?: string      // From resolution data
  claimed?: boolean            // Whether user has claimed winnings/refund
  tokenType?: 'ETH' // v12: token denomination
}

/** Convert 1-indexed outcome number to string key */
export function outcomeToString(outcomeNum: number): string {
  if (outcomeNum === 1) return 'yes'
  if (outcomeNum === 2) return 'no'
  return `outcome_${outcomeNum}`
}

/** Convert outcome string key to 1-indexed number */
export function outcomeToIndex(outcome: string): number {
  if (outcome === 'yes') return 1
  if (outcome === 'no') return 2
  const match = outcome.match(/^outcome_(\d+)$/)
  return match ? parseInt(match[1]) : 1
}

// Phase 2: Commit-Reveal Scheme Records (SDK-based)
export interface CommitmentRecord {
  id: string                        // crypto.randomUUID()
  marketId: string
  amount: bigint
  outcome: string
  commitmentHash: string            // BHP256 hash (stored on-chain)
  userNonce: string                 // field value
  bettor: string                    // address
  betAmountRecordPlaintext: string  // decrypted credits record for reveal
  commitTxId: string
  committedAt: number               // local timestamp
  revealed: boolean
  revealTxId?: string
  marketQuestion?: string
}

export interface WalletState {
  connected: boolean
  connecting: boolean
  privyReady: boolean
  address: string | null
  network: NetworkType
  balance: WalletBalance
  walletType: WalletType | null
  isDemoMode: boolean
  encryptionKey: CryptoKey | null  // wallet-derived AES-256-GCM key for Supabase privacy
}

// ============================================================================
// Wallet Store
// ============================================================================

interface WalletStore {
  wallet: WalletState
  error: string | null

  // Actions
  connect: (walletType: WalletType) => Promise<void>
  disconnect: () => Promise<void>
  refreshBalance: () => Promise<void>
  testTransaction: () => Promise<string>
  clearError: () => void
}

const initialWalletState: WalletState = {
  connected: false,
  connecting: false,
  privyReady: false,
  address: null,
  network: 'testnet',
  balance: { public: 0n, private: 0n },
  walletType: null,
  isDemoMode: false,
  encryptionKey: null,
}

// Track listener cleanup functions to prevent duplicate listeners on reconnect
const _listenerCleanups: (() => void)[] = []

export const useWalletStore = create<WalletStore>((set, get) => ({
  wallet: initialWalletState,
  error: null,

  connect: async (walletType: WalletType) => {
    set({
      wallet: { ...get().wallet, connecting: true },
      error: null,
    })

    try {
      const account = await walletManager.connect(walletType)
      const balance = await walletManager.getBalance()

      set({
        wallet: {
          connected: true,
          connecting: false,
          privyReady: true,
          address: account.address,
          network: account.network,
          balance,
          walletType,
          isDemoMode: walletManager.isDemoMode(),
          encryptionKey: null,
        },
        error: null,
      })

      // Set up event listeners for real wallets
      // Clean up previous listeners first to prevent duplicates
      if (_listenerCleanups.length > 0) {
        _listenerCleanups.forEach(fn => fn())
        _listenerCleanups.length = 0
      }

      if (!walletManager.isDemoMode()) {
        const unsubAccount = walletManager.onAccountChange((newAccount: WalletAccount | null) => {
          if (newAccount) {
            devLog('[Store] Account changed to:', newAccount.address?.slice(0, 12))
            set({
              wallet: {
                ...get().wallet,
                address: newAccount.address,
                network: newAccount.network,
              },
            })
            // Refresh balance for the new account
            setTimeout(() => get().refreshBalance(), 300)
          } else {
            // Account disconnected
            get().disconnect()
          }
        })
        _listenerCleanups.push(unsubAccount)

        const unsubNetwork = walletManager.onNetworkChange((network: NetworkType) => {
          set({
            wallet: {
              ...get().wallet,
              network,
            },
          })
        })
        _listenerCleanups.push(unsubNetwork)
      }
    } catch (error: unknown) {
      console.error('Store connect error:', error)

      // Extract error message from various formats
      let errorMessage = 'Failed to connect wallet'

      if (error instanceof Error) {
        errorMessage = error.message
      } else if (typeof error === 'string') {
        errorMessage = error
      } else if (error && typeof error === 'object') {
        const errObj = error as Record<string, unknown>
        if (typeof errObj.message === 'string') {
          errorMessage = errObj.message
        }
      }

      set({
        wallet: { ...initialWalletState },
        error: errorMessage,
      })
      throw new Error(errorMessage)
    }
  },

  disconnect: async () => {
    try {
      await walletManager.disconnect()
    } catch (error) {
      console.error('Disconnect error:', error)
    }
    set({
      wallet: initialWalletState,
      error: null,
    })
  },

  refreshBalance: async () => {
    const { wallet } = get()
    console.log('[refreshBalance] called, connected:', wallet.connected, 'address:', wallet.address?.slice(0, 10))
    if (!wallet.connected || !wallet.address) {
      console.log('[refreshBalance] skipped — not connected')
      return
    }

    try {
      // Fetch ETH balance via Privy provider (ethers.js)
      const publicBalance = await fetchPublicBalance(wallet.address)
      console.log('[refreshBalance] got balance:', publicBalance.toString(), 'wei')

      // Balance is on-chain; encrypted share balances are stored in the FhenixMarkets contract.
      const balance: WalletBalance = { public: publicBalance, private: 0n }

      set({
        wallet: {
          ...get().wallet,
          balance,
        },
      })
    } catch (error) {
      console.error('Failed to refresh balance:', error)
    }
  },

  testTransaction: async () => {
    const txId = await walletManager.testTransaction()
    devLog('Test transaction submitted:', txId)

    setTimeout(() => {
      useWalletStore.getState().refreshBalance()
    }, 5000)

    return txId
  },

  clearError: () => {
    set({ error: null })
  },
}))

// ============================================================================
// Markets Store
// ============================================================================

interface MarketsStore {
  markets: Market[]
  selectedMarket: Market | null
  isLoading: boolean
  searchQuery: string
  selectedCategory: number | null
  viewMode: 'grid' | 'list'

  // Actions
  fetchMarkets: () => Promise<void>
  selectMarket: (market: Market | null) => void
  setSearchQuery: (query: string) => void
  setCategory: (category: number | null) => void
  setViewMode: (mode: 'grid' | 'list') => void
  getFilteredMarkets: () => Market[]
}

// Categories: 1=Politics, 2=Sports, 3=Crypto, 4=Entertainment, 5=Tech, 6=Economics, 7=Science

// Helper to calculate AMM fields from percentages
const calculateAMMFields = (yesPercentage: number, totalVolume: bigint) => {
  const yesPrice = yesPercentage / 100
  const noPrice = 1 - yesPrice

  // Calculate reserves based on constant product formula
  // For simplicity: yesReserve * noReserve = k
  // yesPrice = noReserve / (yesReserve + noReserve)
  const totalLiquidity = Number(totalVolume) * 2 // Approximate total liquidity
  const yesReserve = BigInt(Math.floor(totalLiquidity * noPrice))
  const noReserve = BigInt(Math.floor(totalLiquidity * yesPrice))

  return {
    yesReserve,
    noReserve,
    reserve3: 0n,
    reserve4: 0n,
    totalLiquidity: yesReserve + noReserve,
    totalLPShares: 0n,
    yesPrice,
    noPrice,
    numOutcomes: 2,
    outcomeLabels: ['Yes', 'No'],
    totalYesIssued: BigInt(Math.floor(Number(totalVolume) * yesPrice)),
    totalNoIssued: BigInt(Math.floor(Number(totalVolume) * noPrice)),
  }
}

// ============================================================================
// MOCK DATA FOR DEMONSTRATION
// ============================================================================
// These markets are for UI demonstration only and are NOT on-chain.
// Real markets created via the "Create Market" modal will be stored on-chain
// in the FhenixMarkets.sol contract on Sepolia.
//
// TODO: Replace with real blockchain data once indexer is available
// An indexer service will track market creation events and provide a list
// of all market IDs that can be queried from the blockchain.
// ============================================================================

const mockMarkets: Market[] = [
  // === CRYPTO MARKETS ===
  {
    id: 'market_001',
    question: 'Will Bitcoin reach $150,000 by end of Q1 2026?',
    description: 'This market resolves YES if the price of Bitcoin (BTC) reaches or exceeds $150,000 USD on any major exchange (Coinbase, Binance, Kraken) before March 31, 2026 11:59 PM UTC.',
    category: 3,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 65 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 68 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 62.5,
    noPercentage: 37.5,
    totalVolume: 2500000000n, // 2500 ETH
    totalBets: 342,
    ...calculateAMMFields(62.5, 2500000000n),
    potentialYesPayout: 1.60,
    potentialNoPayout: 2.67,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '65d',
    resolutionSource: 'CoinGecko API',
    tags: ['Bitcoin', 'Price Prediction', 'Hot'],
  },
  {
    id: 'market_002',
    question: 'Will Ethereum flip Bitcoin in market cap by 2027?',
    description: 'Resolves YES if Ethereum market capitalization exceeds Bitcoin market cap at any point before January 1, 2027.',
    category: 3,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 370 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 18.2,
    noPercentage: 81.8,
    totalVolume: 1800000000n,
    totalBets: 567,
    ...calculateAMMFields(18.2, 1800000000n),
    potentialYesPayout: 5.49,
    potentialNoPayout: 1.22,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '365d',
    resolutionSource: 'CoinMarketCap',
    tags: ['Ethereum', 'Bitcoin', 'Flippening'],
  },
  {
    id: 'market_003',
    question: 'Will Solana reach $500 before ETH reaches $10,000?',
    description: 'Race market: Resolves YES if SOL reaches $500 first, NO if ETH reaches $10,000 first. If neither happens by end of 2026, resolves NO.',
    category: 3,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 340 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 345 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 45.3,
    noPercentage: 54.7,
    totalVolume: 980000000n,
    totalBets: 234,
    ...calculateAMMFields(45.3, 980000000n),
    potentialYesPayout: 2.21,
    potentialNoPayout: 1.83,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '340d',
    resolutionSource: 'CoinGecko API',
    tags: ['Solana', 'Ethereum', 'Race'],
  },
  {
    id: 'market_004',
    question: 'Will ETH price exceed $5,000 by June 2026?',
    description: 'Resolves YES if ETH trades above $5,000 USD on any major exchange before June 30, 2026.',
    category: 3,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 155 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 160 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 71.8,
    noPercentage: 28.2,
    totalVolume: 3200000000n,
    totalBets: 892,
    ...calculateAMMFields(71.8, 3200000000n),
    potentialYesPayout: 1.39,
    potentialNoPayout: 3.55,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '155d',
    resolutionSource: 'CoinGecko API',
    tags: ['Fhenix', 'Price', 'Featured'],
  },
  // === ECONOMICS MARKETS ===
  {
    id: 'market_005',
    question: 'Will the Fed cut interest rates in February 2026?',
    description: 'Resolves YES if the Federal Reserve announces a rate cut at the FOMC meeting in February 2026.',
    category: 6,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 16 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 36.3,
    noPercentage: 63.7,
    totalVolume: 1450000000n,
    totalBets: 423,
    ...calculateAMMFields(36.3, 1450000000n),
    potentialYesPayout: 2.75,
    potentialNoPayout: 1.57,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '14d',
    resolutionSource: 'Federal Reserve',
    tags: ['Fed', 'Interest Rates', 'Ending Soon'],
  },
  {
    id: 'market_006',
    question: 'Will US inflation drop below 2% by Q2 2026?',
    description: 'Resolves YES if the official US CPI year-over-year inflation rate drops below 2.0% in any month of Q2 2026.',
    category: 6,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 120 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 125 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 42.1,
    noPercentage: 57.9,
    totalVolume: 890000000n,
    totalBets: 312,
    ...calculateAMMFields(42.1, 890000000n),
    potentialYesPayout: 2.38,
    potentialNoPayout: 1.73,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '120d',
    resolutionSource: 'Bureau of Labor Statistics',
    tags: ['Inflation', 'Economy'],
  },
  // === TECH MARKETS ===
  {
    id: 'market_007',
    question: 'Will Apple announce Apple Intelligence 2.0 at WWDC 2026?',
    description: 'Resolves YES if Apple announces a major update to Apple Intelligence branded as "2.0" or equivalent at WWDC 2026.',
    category: 5,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 135 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 140 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 72.4,
    noPercentage: 27.6,
    totalVolume: 1230000000n,
    totalBets: 456,
    ...calculateAMMFields(72.4, 1230000000n),
    potentialYesPayout: 1.38,
    potentialNoPayout: 3.62,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '135d',
    resolutionSource: 'Apple Official Announcement',
    tags: ['Apple', 'AI', 'WWDC'],
  },
  {
    id: 'market_008',
    question: 'Will OpenAI release GPT-5 before July 2026?',
    description: 'Resolves YES if OpenAI publicly releases or announces GPT-5 (or equivalent next-gen model) before July 1, 2026.',
    category: 5,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 160 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 165 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 58.9,
    noPercentage: 41.1,
    totalVolume: 2100000000n,
    totalBets: 678,
    ...calculateAMMFields(58.9, 2100000000n),
    potentialYesPayout: 1.70,
    potentialNoPayout: 2.43,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '160d',
    resolutionSource: 'OpenAI Official',
    tags: ['OpenAI', 'GPT-5', 'AI'],
  },
  // === SPORTS MARKETS ===
  {
    id: 'market_009',
    question: 'Will Real Madrid win Champions League 2026?',
    description: 'Resolves YES if Real Madrid CF wins the UEFA Champions League 2025-26 season.',
    category: 2,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 120 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 122 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 28.5,
    noPercentage: 71.5,
    totalVolume: 1560000000n,
    totalBets: 534,
    ...calculateAMMFields(28.5, 1560000000n),
    potentialYesPayout: 3.51,
    potentialNoPayout: 1.40,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '120d',
    resolutionSource: 'UEFA Official',
    tags: ['Champions League', 'Real Madrid', 'Football'],
  },
  {
    id: 'market_010',
    question: 'Will the Super Bowl 2026 have over 110M US viewers?',
    description: 'Resolves YES if official Nielsen ratings show over 110 million US viewers for Super Bowl LX.',
    category: 2,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 25 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 67.2,
    noPercentage: 32.8,
    totalVolume: 780000000n,
    totalBets: 289,
    ...calculateAMMFields(67.2, 780000000n),
    potentialYesPayout: 1.49,
    potentialNoPayout: 3.05,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '20d',
    resolutionSource: 'Nielsen Ratings',
    tags: ['Super Bowl', 'NFL', 'Trending'],
  },
  // === POLITICS MARKETS ===
  {
    id: 'market_011',
    question: 'Will a new crypto regulation bill pass US Congress in 2026?',
    description: 'Resolves YES if any comprehensive cryptocurrency regulation bill is signed into law in the US during 2026.',
    category: 1,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 340 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 345 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 45.8,
    noPercentage: 54.2,
    totalVolume: 920000000n,
    totalBets: 367,
    ...calculateAMMFields(45.8, 920000000n),
    potentialYesPayout: 2.18,
    potentialNoPayout: 1.85,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '340d',
    resolutionSource: 'US Congress Records',
    tags: ['Regulation', 'Crypto', 'Politics'],
  },
  // === ENDING SOON ===
  {
    id: 'market_012',
    question: 'Will ETH close above $4,000 this week?',
    description: 'Resolves YES if Ethereum (ETH) price is above $4,000 at Sunday 11:59 PM UTC.',
    category: 3,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60),
    resolutionDeadline: BigInt(Math.floor(Date.now() / 1000) + 4 * 24 * 60 * 60),
    status: 1,
    yesPercentage: 52.3,
    noPercentage: 47.7,
    totalVolume: 650000000n,
    totalBets: 198,
    ...calculateAMMFields(52.3, 650000000n),
    potentialYesPayout: 1.91,
    potentialNoPayout: 2.10,
    creator: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timeRemaining: '3d',
    resolutionSource: 'CoinGecko API',
    tags: ['Ethereum', 'Weekly', 'Ending Soon'],
  },
]

export const useMarketsStore = create<MarketsStore>((set, get) => ({
  markets: [],
  selectedMarket: null,
  isLoading: false,
  searchQuery: '',
  selectedCategory: null,
  viewMode: 'grid',

  fetchMarkets: async () => {
    set({ isLoading: true })
    try {
      // TODO: Implement real blockchain data fetching
      // For now, we'll use mock data until we have an indexer or can query the chain
      // In production, this would:
      // 1. Query all market IDs from an indexer
      // 2. Fetch each market's data from the blockchain
      // 3. Fetch pool data for each market
      // 4. Transform to Market format

      // Temporary: Use mock data for demo
      await new Promise(resolve => setTimeout(resolve, 800))
      set({ markets: mockMarkets, isLoading: false })
    } catch (error) {
      console.error('Failed to fetch markets:', error)
      set({ markets: [], isLoading: false })
    }
  },

  selectMarket: (market) => {
    set({ selectedMarket: market })
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query })
  },

  setCategory: (category) => {
    set({ selectedCategory: category })
  },

  setViewMode: (mode) => {
    set({ viewMode: mode })
  },

  getFilteredMarkets: () => {
    const { markets, searchQuery, selectedCategory } = get()

    return markets.filter(market => {
      // Filter by search query
      if (searchQuery && !market.question.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false
      }
      // Filter by category
      if (selectedCategory !== null && market.category !== selectedCategory) {
        return false
      }
      return true
    })
  },
}))

// ============================================================================
// Bets Store
// ============================================================================

interface BetsStore {
  userBets: Bet[]
  pendingBets: Bet[]
  isPlacingBet: boolean
  commitmentRecords: CommitmentRecord[]  // Phase 2: Store commitments for reveal

  // Actions
  placeBet: (marketId: string, amount: bigint, outcome: string) => Promise<string>  // Legacy method
  addPendingBet: (bet: Bet) => void  // Save bet from external tx (e.g. BettingModal)
  confirmPendingBet: (pendingBetId: string, confirmedTxId?: string) => void
  removePendingBet: (pendingBetId: string) => void
  storeCommitment: (commitment: CommitmentRecord) => void
  markRevealed: (commitmentId: string, revealTxId: string) => void
  exportCommitments: () => string
  importCommitments: (json: string) => number
  fetchUserBets: () => Promise<void>
  loadBetsForAddress: (address: string) => void
  syncBetStatuses: () => Promise<void>
  markBetClaimed: (betId: string) => void
  markBetUnclaimed: (betId: string) => void
  reconcileClaimedBets: () => Promise<number>
  getBetsByMarket: (marketId: string) => Bet[]
  getTotalBetsValue: () => bigint
  getCommitmentRecords: (marketId?: string) => CommitmentRecord[]
  getPendingReveals: () => CommitmentRecord[]
  flushToSupabase: () => Promise<void>
}

// Per-address localStorage key helpers
function getBetsKey(address: string): string {
  return `fhenix_markets_bets_${address}`
}
function getPendingBetsKey(address: string): string {
  return `fhenix_markets_pending_${address}`
}
function getCommitmentsKey(address: string): string {
  return `fhenix_markets_commitments_${address}`
}

// Migrate old global localStorage keys to per-address keys
function migrateGlobalToAddressScoped(address: string): void {
  if (typeof window === 'undefined') return
  try {
    const oldBets = localStorage.getItem('fhenix_markets_user_bets')
    const oldPending = localStorage.getItem('fhenix_markets_pending_bets')
    const oldCommitments = localStorage.getItem('fhenix_markets_commitments')

    if (oldBets && !localStorage.getItem(getBetsKey(address))) {
      localStorage.setItem(getBetsKey(address), oldBets)
      localStorage.removeItem('fhenix_markets_user_bets')
    }
    if (oldPending && !localStorage.getItem(getPendingBetsKey(address))) {
      localStorage.setItem(getPendingBetsKey(address), oldPending)
      localStorage.removeItem('fhenix_markets_pending_bets')
    }
    if (oldCommitments && !localStorage.getItem(getCommitmentsKey(address))) {
      localStorage.setItem(getCommitmentsKey(address), oldCommitments)
      localStorage.removeItem('fhenix_markets_commitments')
    }
  } catch (e) {
    console.error('Migration failed:', e)
  }
}

function parseBetFromStorage(bet: any): Bet {
  return {
    ...bet,
    amount: BigInt(bet.amount),
    sharesReceived: bet.sharesReceived ? BigInt(bet.sharesReceived) : undefined,
    sharesSold: bet.sharesSold ? BigInt(bet.sharesSold) : undefined,
    tokensReceived: bet.tokensReceived ? BigInt(bet.tokensReceived) : undefined,
    payoutAmount: bet.payoutAmount ? BigInt(bet.payoutAmount) : undefined,
  }
}

function serializeBetForStorage(bet: Bet): any {
  return {
    ...bet,
    amount: bet.amount.toString(),
    sharesReceived: bet.sharesReceived?.toString(),
    sharesSold: bet.sharesSold?.toString(),
    tokensReceived: bet.tokensReceived?.toString(),
    payoutAmount: bet.payoutAmount?.toString(),
  }
}

// Helper to load bets from localStorage (per-address), with deduplication
function loadBetsFromStorage(address?: string): Bet[] {
  if (typeof window === 'undefined' || !address) return []
  try {
    const saved = localStorage.getItem(getBetsKey(address))
    if (!saved) return []
    const parsed = JSON.parse(saved)
    const bets: Bet[] = parsed.map(parseBetFromStorage)
    // Deduplicate by bet ID (keep last occurrence which has the most recent status)
    const byId = new Map<string, Bet>()
    for (const bet of bets) byId.set(bet.id, bet)
    const deduped = Array.from(byId.values())
    if (deduped.length < bets.length) {
      devWarn(`[Bets] Deduped ${bets.length - deduped.length} duplicate bets from localStorage`)
      // Save cleaned data back
      const serializable = deduped.map(serializeBetForStorage)
      localStorage.setItem(getBetsKey(address), JSON.stringify(serializable))
    }
    return deduped
  } catch (e) {
    console.error('Failed to load bets from storage:', e)
    return []
  }
}

// Helper to load pending bets from localStorage (per-address)
function loadPendingBetsFromStorage(address?: string): Bet[] {
  if (typeof window === 'undefined' || !address) return []
  try {
    const saved = localStorage.getItem(getPendingBetsKey(address))
    if (!saved) return []
    const parsed = JSON.parse(saved)
    return parsed.map(parseBetFromStorage)
  } catch (e) {
    console.error('Failed to load pending bets from storage:', e)
    return []
  }
}

// Helper to save pending bets to localStorage (per-address)
function savePendingBetsToStorage(bets: Bet[]) {
  const { address, encryptionKey } = useWalletStore.getState().wallet
  if (typeof window === 'undefined' || !address) {
    devWarn('[Bets] savePendingBetsToStorage SKIPPED — no address:', address)
    return
  }
  try {
    const serializable = bets.map(serializeBetForStorage)
    const key = getPendingBetsKey(address)
    localStorage.setItem(key, JSON.stringify(serializable))
    devWarn(`[Bets] Saved ${bets.length} pending bets to localStorage key: ${key}`)
    // Sync to Supabase (encrypted if key available, plaintext otherwise)
    if (isSupabaseAvailable()) {
      sbUpsertPendingBets(bets, address, encryptionKey).catch(err =>
        devWarn('[Supabase] Failed to sync pending bets:', err)
      )
    }
  } catch (e) {
    console.error('[Bets] Failed to save pending bets to storage:', e)
  }
}

// Helper to save bets to localStorage (per-address)
function saveBetsToStorage(bets: Bet[]) {
  const { address, encryptionKey } = useWalletStore.getState().wallet
  if (typeof window === 'undefined' || !address) return
  try {
    const serializable = bets.map(serializeBetForStorage)
    localStorage.setItem(getBetsKey(address), JSON.stringify(serializable))
    // Sync to Supabase (encrypted if key available, plaintext otherwise)
    if (isSupabaseAvailable()) {
      sbUpsertBets(bets, address, encryptionKey).catch(err =>
        devWarn('[Supabase] Failed to sync bets:', err)
      )
    }
  } catch (e) {
    console.error('Failed to save bets to storage:', e)
  }
}

// Helper to load commitment records from localStorage (per-address)
function loadCommitmentRecordsFromStorage(address?: string): CommitmentRecord[] {
  if (typeof window === 'undefined' || !address) return []
  try {
    const saved = localStorage.getItem(getCommitmentsKey(address))
    if (!saved) return []
    const parsed = JSON.parse(saved)
    return parsed.map((record: any) => ({
      ...record,
      amount: BigInt(record.amount),
    }))
  } catch (e) {
    console.error('Failed to load commitment records from storage:', e)
    return []
  }
}

// Helper to save commitment records to localStorage (per-address)
// SECURITY: betAmountRecordPlaintext is stripped before persistence — it contains
// decrypted credits record data that should not be stored in localStorage or Supabase.
function saveCommitmentRecordsToStorage(records: CommitmentRecord[]) {
  const { address, encryptionKey } = useWalletStore.getState().wallet
  if (typeof window === 'undefined' || !address) return
  try {
    const serializable = records.map(record => ({
      ...record,
      amount: record.amount.toString(),
      betAmountRecordPlaintext: '[REDACTED]',
    }))
    localStorage.setItem(getCommitmentsKey(address), JSON.stringify(serializable))
    // Sync to Supabase (encrypted if key available, plaintext otherwise)
    if (isSupabaseAvailable()) {
      sbUpsertCommitments(records, address, encryptionKey).catch(err =>
        devWarn('[Supabase] Failed to sync commitments:', err)
      )
    }
  } catch (e) {
    console.error('Failed to save commitment records to storage:', e)
  }
}

// ---- Wallet record refresh helper ----
// After a bet is confirmed on-chain, try to fetch actual OutcomeShare records
// from the wallet and update sharesReceived with the real on-chain quantity.
// Best-effort: silently fails if wallet doesn't support record fetching.

// On Ethereum, share balances are encrypted in the FhenixMarkets contract (euint128).
// No client-side record scanning needed — tx.wait() confirms shares on-chain.
async function refreshSharesFromWallet(
  _bet: Bet,
  _get: () => { userBets: Bet[] },
  _set: (partial: Partial<{ userBets: Bet[] }>) => void,
) {
  // Share balances are stored in FHE contract state.
}

// ---- Supabase background sync helpers ----

async function syncFromSupabase(
  address: string,
  set: (partial: Partial<{ userBets: Bet[]; pendingBets: Bet[]; commitmentRecords: CommitmentRecord[] }>) => void,
  get: () => { userBets: Bet[]; pendingBets: Bet[]; commitmentRecords: CommitmentRecord[] }
) {
  try {
    // Wait for encryption key if not yet available (WalletBridge may still be deriving it)
    let encryptionKey = useWalletStore.getState().wallet.encryptionKey
    if (!encryptionKey) {
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2000))
        encryptionKey = useWalletStore.getState().wallet.encryptionKey
        if (encryptionKey) break
      }
    }
    const [remoteBets, remotePending, remoteCommitments] = await Promise.all([
      sbFetchBets(address, encryptionKey),
      sbFetchPendingBets(address, encryptionKey),
      sbFetchCommitments(address, encryptionKey),
    ])

    if (remoteBets.length > 0) {
      const merged = mergeBets(get().userBets, remoteBets)
      set({ userBets: merged })
      const serializable = merged.map(serializeBetForStorage)
      localStorage.setItem(getBetsKey(address), JSON.stringify(serializable))
    }

    if (remotePending.length > 0) {
      const merged = mergeBets(get().pendingBets, remotePending)
      set({ pendingBets: merged })
      const serializable = merged.map(serializeBetForStorage)
      localStorage.setItem(getPendingBetsKey(address), JSON.stringify(serializable))
    }

    if (remoteCommitments.length > 0) {
      const merged = mergeCommitments(get().commitmentRecords, remoteCommitments)
      set({ commitmentRecords: merged })
      const serializable = merged.map(r => ({ ...r, amount: r.amount.toString() }))
      localStorage.setItem(getCommitmentsKey(address), JSON.stringify(serializable))
    }
  } catch (error) {
    devWarn('[Supabase] Background sync failed:', error)
  }
}

function mergeBets(local: Bet[], remote: Bet[]): Bet[] {
  const byId = new Map<string, Bet>()
  const STATUS_PRIORITY: Record<string, number> = {
    pending: 0, active: 1, won: 2, lost: 2, refunded: 2,
  }
  for (const bet of local) byId.set(bet.id, bet)
  for (const bet of remote) {
    const existing = byId.get(bet.id)
    if (!existing) {
      byId.set(bet.id, bet)
    } else {
      const localPri = STATUS_PRIORITY[existing.status] ?? 0
      const remotePri = STATUS_PRIORITY[bet.status] ?? 0
      if (remotePri >= localPri) {
        byId.set(bet.id, { ...existing, ...bet })
      }
    }
  }
  return Array.from(byId.values())
}

async function resolvePendingBetStatus(bet: Bet): Promise<{
  status: 'confirmed' | 'rejected' | 'pending';
  transactionId?: string;
}> {
  if (bet.id.startsWith('0x')) {
    const diagnosis = await diagnoseTransaction(bet.id)
    if (diagnosis.status === 'accepted') {
      return { status: 'confirmed', transactionId: bet.id }
    }
    if (diagnosis.status === 'rejected') {
      return { status: 'rejected', transactionId: bet.id }
    }
  }

  const walletStatus = await lookupWalletTransactionStatus(bet.id)
  const resolvedTxId = walletStatus?.transactionId

  if (resolvedTxId?.startsWith('0x')) {
    try {
      const diagnosis = await diagnoseTransaction(resolvedTxId)
      if (diagnosis.status === 'accepted') {
        return { status: 'confirmed', transactionId: resolvedTxId }
      }
      if (diagnosis.status === 'rejected') {
        return { status: 'rejected', transactionId: resolvedTxId }
      }
    } catch {
      // Fall back to the wallet-native status below.
    }
  }

  if (walletStatus?.status === 'accepted') {
    return { status: 'confirmed', transactionId: resolvedTxId }
  }

  if (walletStatus?.status === 'rejected') {
    return { status: 'rejected', transactionId: resolvedTxId }
  }

  return { status: 'pending', transactionId: resolvedTxId }
}

function mergeCommitments(local: CommitmentRecord[], remote: CommitmentRecord[]): CommitmentRecord[] {
  const byId = new Map<string, CommitmentRecord>()
  for (const r of local) byId.set(r.id, r)
  for (const r of remote) {
    const existing = byId.get(r.id)
    if (!existing || (r.revealed && !existing.revealed)) {
      byId.set(r.id, r)
    }
  }
  return Array.from(byId.values())
}

export const useBetsStore = create<BetsStore>((set, get) => ({
  userBets: [],
  pendingBets: [],
  commitmentRecords: [],
  isPlacingBet: false,

  placeBet: async (marketId, amount, outcome) => {
    const walletState = useWalletStore.getState().wallet

    if (!walletState.connected) {
      throw new Error('Wallet not connected')
    }

    if (!walletState.address) {
      throw new Error('Wallet address not available')
    }

    set({ isPlacingBet: true })

    try {
      // Get market question for display purposes (use real blockchain store)
      const { useRealMarketsStore } = await import('./market-store')
      const realMarkets = useRealMarketsStore.getState().markets
      const market = realMarkets.find(m => m.id === marketId)
      const marketQuestion = market?.question || `Market ${marketId}`

      // Build inputs for the active market contract (ETH only).
      const tokenType = 'ETH'
      const outcomeNum = outcomeToIndex(outcome)

      let creditsRecord: string | undefined

      // On Ethereum, no credits record needed — ETH is sent as msg.value
      void tokenType

      const { functionName: betFunctionName, inputs } = buildBuySharesInputs(
        marketId,
        outcomeNum,
        amount,
        0n, // expectedShares
        0n, // minSharesOut
        'ETH',
        creditsRecord,
      )

      devLog('=== PLACE BET DEBUG ===')
      devLog('Market ID:', marketId)
      devLog('Amount:', amount.toString())
      devLog('Outcome:', outcome)
      devLog('Function:', betFunctionName)
      devLog('Program ID:', CONTRACT_INFO.programId)

      // Validate inputs
      for (let i = 0; i < inputs.length; i++) {
        if (typeof inputs[i] !== 'string') {
          throw new Error(`Input ${i} is not a string: ${typeof inputs[i]}`)
        }
        if (!inputs[i]) {
          throw new Error(`Input ${i} is empty`)
        }
      }

      // Request transaction through wallet
      const programId = getProgramIdForToken('ETH')
      const transactionId = await walletManager.requestTransaction({
        programId,
        functionName: betFunctionName,
        inputs,
        fee: 1.5, // 1.5 ETH fee for v31
      })

      devLog('Bet transaction submitted:', transactionId)

      // Immediately refresh balance
      setTimeout(() => {
        useWalletStore.getState().refreshBalance()
      }, 1000)

      // Calculate locked multiplier for display
      const idx = outcomeToIndex(outcome) - 1 // 0-indexed
      const lockedMultiplier = idx === 0
        ? market?.potentialYesPayout
        : idx === 1
          ? market?.potentialNoPayout
          : undefined

      // Add to pending bets with market question and locked odds
      const newBet: Bet = {
        id: transactionId,
        marketId,
        amount,
        outcome,
        placedAt: Date.now(),
        status: 'pending',
        marketQuestion,
        lockedMultiplier,
      }

      const updatedPendingBets = [...get().pendingBets, newBet]
      set({
        pendingBets: updatedPendingBets,
        isPlacingBet: false,
      })

      // Save pending bets to localStorage immediately
      savePendingBetsToStorage(updatedPendingBets)

      // Refresh balance multiple times to catch the update
      const refreshIntervals = [3000, 5000, 10000, 15000, 30000]
      refreshIntervals.forEach(delay => {
        setTimeout(() => {
          devLog(`Refreshing balance after ${delay}ms...`)
          useWalletStore.getState().refreshBalance()
        }, delay)
      })

      // Poll for transaction confirmation
      // If we got a UUID (MetaMask event ID) instead of at1... tx ID,
      // skip explorer polling - the bet was accepted by the wallet
      const isRealTxId = transactionId.startsWith('0x')

      if (isRealTxId) {
        // Real at1... tx ID: poll the explorer for confirmation
        const pollInterval = setInterval(async () => {
          try {
            const response = await fetch(
              `${config.rpcUrl}/transaction/${transactionId}`
            )
            if (response.ok) {
              clearInterval(pollInterval)
              const activeBet = { ...newBet, status: 'active' as const }
              const alreadyExists = get().userBets.some(b => b.id === transactionId)
              const updatedBets = alreadyExists ? get().userBets : [...get().userBets, activeBet]
              const updatedPending = get().pendingBets.filter(b => b.id !== transactionId)
              set({
                pendingBets: updatedPending,
                userBets: updatedBets,
              })
              saveBetsToStorage(updatedBets)
              savePendingBetsToStorage(updatedPending)
              // Remove from Supabase pending_bets
              if (isSupabaseAvailable() && walletState.address) {
                sbRemovePendingBet(transactionId, walletState.address)
              }
              devLog('Transaction confirmed, final balance refresh...')
              useWalletStore.getState().refreshBalance()
              // Best-effort: refresh sharesReceived from actual wallet record
              refreshSharesFromWallet(activeBet, get, set)
            }
          } catch {
            // Transaction not confirmed yet, continue polling
          }
        }, 5000)

        // Timeout after 2 minutes
        setTimeout(() => {
          clearInterval(pollInterval)
          const stillPending = get().pendingBets.find(b => b.id === transactionId)
          if (stillPending) {
            const activeBet = { ...newBet, status: 'active' as const }
            const alreadyExists = get().userBets.some(b => b.id === transactionId)
            const updatedBets = alreadyExists ? get().userBets : [...get().userBets, activeBet]
            const updatedPending = get().pendingBets.filter(b => b.id !== transactionId)
            set({
              pendingBets: updatedPending,
              userBets: updatedBets,
            })
            saveBetsToStorage(updatedBets)
            savePendingBetsToStorage(updatedPending)
            if (isSupabaseAvailable() && walletState.address) {
              sbRemovePendingBet(transactionId, walletState.address)
            }
          }
        }, 120000)
      } else {
        // UUID (MetaMask event ID): bet was accepted by wallet, mark as active immediately
        // MetaMask doesn't expose the real at1... tx ID through its adapter API
        devLog('Transaction submitted via MetaMask (UUID event ID). Marking as active.')
        devLog('User can find the real transaction ID in their MetaMask extension.')

        // Short delay then mark as active (the wallet accepted it)
        setTimeout(() => {
          const activeBet = { ...newBet, status: 'active' as const }
          const alreadyExists = get().userBets.some(b => b.id === transactionId)
          const updatedBets = alreadyExists ? get().userBets : [...get().userBets, activeBet]
          const updatedPending = get().pendingBets.filter(b => b.id !== transactionId)
          set({
            pendingBets: updatedPending,
            userBets: updatedBets,
          })
          saveBetsToStorage(updatedBets)
          savePendingBetsToStorage(updatedPending)
          if (isSupabaseAvailable() && walletState.address) {
            sbRemovePendingBet(transactionId, walletState.address)
          }
          // Best-effort: refresh sharesReceived from actual wallet record
          refreshSharesFromWallet(activeBet, get, set)
        }, 5000)
      }

      return transactionId
    } catch (error: any) {
      console.error('Place bet error:', error)
      set({ isPlacingBet: false })
      throw error
    }
  },

  // Save a bet from external transaction flow (e.g. BettingModal)
  addPendingBet: (bet: Bet) => {
    const address = useWalletStore.getState().wallet.address
    devWarn('[Bets] addPendingBet called:', {
      betId: bet.id,
      marketId: bet.marketId?.slice(0, 20) + '...',
      amount: String(bet.amount),
      outcome: bet.outcome,
      status: bet.status,
      walletAddress: address || 'NOT CONNECTED',
    })

    const existingPending = get().pendingBets.find(b => b.id === bet.id)
    const existingUser = get().userBets.find(b => b.id === bet.id)

    if (existingPending || existingUser) {
      devWarn('[Bets] Skip duplicate pending bet:', bet.id)
      return
    }

    const updatedPending = [...get().pendingBets, bet]
    set({ pendingBets: updatedPending })
    savePendingBetsToStorage(updatedPending)
    devWarn('[Bets] Added pending bet:', bet.id, 'total pending:', updatedPending.length)

    // Verify it was saved to localStorage
    if (address) {
      const saved = localStorage.getItem(`fhenix_markets_pending_${address}`)
      devWarn('[Bets] localStorage verification:', saved ? `${JSON.parse(saved).length} bets saved` : 'EMPTY/NULL')
    }
  },

  confirmPendingBet: (pendingBetId: string, confirmedTxId?: string) => {
    const pendingBet = get().pendingBets.find(b => b.id === pendingBetId)
    if (!pendingBet) return

    const activeBet: Bet = {
      ...pendingBet,
      id: confirmedTxId || pendingBet.id,
      status: 'active',
    }

    const updatedPending = get().pendingBets.filter(b => b.id !== pendingBetId)

    const existingIdx = get().userBets.findIndex(b => b.id === activeBet.id)
    const updatedUserBets = [...get().userBets]
    if (existingIdx >= 0) {
      updatedUserBets[existingIdx] = { ...updatedUserBets[existingIdx], ...activeBet }
    } else {
      updatedUserBets.push(activeBet)
    }

    set({
      pendingBets: updatedPending,
      userBets: updatedUserBets,
    })
    savePendingBetsToStorage(updatedPending)
    saveBetsToStorage(updatedUserBets)

    const address = useWalletStore.getState().wallet.address
    if (isSupabaseAvailable() && address) {
      sbRemovePendingBet(pendingBetId, address)
    }
  },

  removePendingBet: (pendingBetId: string) => {
    const inPending = get().pendingBets.some(b => b.id === pendingBetId)
    const inActive = get().userBets.some(b => b.id === pendingBetId)

    if (!inPending && !inActive) return

    if (inPending) {
      const updatedPending = get().pendingBets.filter(b => b.id !== pendingBetId)
      set({ pendingBets: updatedPending })
      savePendingBetsToStorage(updatedPending)
    }

    // Also remove from userBets if already auto-promoted (e.g. syncBetStatuses ran before failed status arrived)
    if (inActive) {
      const updatedBets = get().userBets.filter(b => b.id !== pendingBetId)
      set({ userBets: updatedBets })
      saveBetsToStorage(updatedBets)
      devWarn(`[Bets] Removed failed/rejected bet ${pendingBetId.slice(0, 20)}... from userBets`)
    }

    const address = useWalletStore.getState().wallet.address
    if (isSupabaseAvailable() && address) {
      sbRemovePendingBet(pendingBetId, address)
      if (inActive) {
        sbRemoveUserBet(pendingBetId, address)
      }
    }
  },

  // Phase 2: Commit-Reveal Scheme - Store commitment data from SDK worker
  storeCommitment: (commitment: CommitmentRecord) => {
    const updatedCommitments = [...get().commitmentRecords, commitment]
    set({ commitmentRecords: updatedCommitments })
    saveCommitmentRecordsToStorage(updatedCommitments)
    devLog('Commitment stored:', commitment.id, 'market:', commitment.marketId)
  },

  // Phase 2: Mark a commitment as revealed
  markRevealed: (commitmentId: string, revealTxId: string) => {
    const updatedCommitments = get().commitmentRecords.map(record =>
      record.id === commitmentId
        ? { ...record, revealed: true, revealTxId }
        : record
    )
    set({ commitmentRecords: updatedCommitments })
    saveCommitmentRecordsToStorage(updatedCommitments)
    devLog('Commitment revealed:', commitmentId, 'tx:', revealTxId)
  },

  // Phase 2: Export all commitments as JSON for backup
  exportCommitments: (): string => {
    const records = get().commitmentRecords
    const serializable = records.map(record => ({
      ...record,
      amount: record.amount.toString(),
    }))
    return JSON.stringify(serializable, null, 2)
  },

  // Phase 2: Import commitments from JSON backup
  importCommitments: (json: string): number => {
    try {
      const parsed = JSON.parse(json)
      if (!Array.isArray(parsed)) throw new Error('Invalid format: expected array')

      const imported: CommitmentRecord[] = parsed.map((record: any) => ({
        ...record,
        amount: BigInt(record.amount),
      }))

      // Merge: skip duplicates by id
      const existingIds = new Set(get().commitmentRecords.map(r => r.id))
      const newRecords = imported.filter(r => !existingIds.has(r.id))

      if (newRecords.length > 0) {
        const updatedCommitments = [...get().commitmentRecords, ...newRecords]
        set({ commitmentRecords: updatedCommitments })
        saveCommitmentRecordsToStorage(updatedCommitments)
      }

      devLog(`Imported ${newRecords.length} new commitments (${imported.length - newRecords.length} duplicates skipped)`)
      return newRecords.length
    } catch (e) {
      console.error('Failed to import commitments:', e)
      throw e
    }
  },

  // Get commitment records (optionally filtered by marketId)
  getCommitmentRecords: (marketId?: string) => {
    const records = get().commitmentRecords
    return marketId ? records.filter(r => r.marketId === marketId) : records
  },

  // Get pending reveals (commitments that haven't been revealed yet)
  getPendingReveals: () => {
    return get().commitmentRecords.filter(r => !r.revealed)
  },

  fetchUserBets: async () => {
    const walletState = useWalletStore.getState().wallet

    if (!walletState.connected || !walletState.address) return

    const address = walletState.address

    // Run migration from global keys to per-address keys
    migrateGlobalToAddressScoped(address)

    try {
      // Load from per-address localStorage
      const localBets = loadBetsFromStorage(address)
      const localPendingBets = loadPendingBetsFromStorage(address)

      // Get markets for question lookup (use real blockchain store)
      const { useRealMarketsStore } = await import('./market-store')
      const realMarkets = useRealMarketsStore.getState().markets
      const getMarketQuestion = (marketId: string) => {
        const market = realMarkets.find(m => m.id === marketId)
        return market?.question || `Market ${marketId}`
      }

      // Try to fetch from wallet records (may not work with all wallets)
      let walletBets: Bet[] = []
      try {
        const records = await walletManager.getRecords(CONTRACT_INFO.programId)
        walletBets = records
          .filter((r: any) => r.type === 'Bet')
          .map((r: any) => ({
            id: r.id,
            marketId: r.data.market_id,
            amount: BigInt(r.data.amount),
            outcome: outcomeToString(parseInt(r.data.outcome)),
            placedAt: parseInt(r.data.placed_at),
            status: 'active' as const,
            marketQuestion: getMarketQuestion(r.data.market_id),
          }))
      } catch {
        // Wallet records not available (expected with MetaMask)
      }

      // Merge: use wallet bets if available, otherwise use local cache
      const existingIds = new Set(walletBets.map(b => b.id))
      const mergedBets = [
        ...walletBets,
        ...localBets.filter(b => !existingIds.has(b.id)).map(b => ({
          ...b,
          marketQuestion: b.marketQuestion || getMarketQuestion(b.marketId),
        }))
      ]

      set({
        userBets: mergedBets,
        pendingBets: localPendingBets,
      })

      if (mergedBets.length > 0) {
        saveBetsToStorage(mergedBets)
      }

      // Background: merge from Supabase if available
      if (isSupabaseAvailable()) {
        syncFromSupabase(address, set, get)
      }
    } catch (error) {
      console.error('Failed to fetch user bets:', error)
      const localBets = loadBetsFromStorage(address)
      const localPendingBets = loadPendingBetsFromStorage(address)
      set({
        userBets: localBets,
        pendingBets: localPendingBets,
      })
    }
  },

  loadBetsForAddress: (address: string) => {
    migrateGlobalToAddressScoped(address)
    // Instant: load from localStorage
    const bets = loadBetsFromStorage(address)
    const pending = loadPendingBetsFromStorage(address)
    const commitments = loadCommitmentRecordsFromStorage(address)
    set({
      userBets: bets,
      pendingBets: pending,
      commitmentRecords: commitments,
    })
    // Background: merge from Supabase if available
    if (isSupabaseAvailable()) {
      syncFromSupabase(address, set, get)
    }
  },

  syncBetStatuses: async () => {
    // --- Reconcile pending bets using on-chain + native wallet status ---
    const pendingSnapshot = [...get().pendingBets]
    if (pendingSnapshot.length > 0) {
      const confirmed: Array<{ pendingId: string; confirmedTxId?: string }> = []
      const rejected: string[] = []

      for (const bet of pendingSnapshot) {
        try {
          const resolution = await resolvePendingBetStatus(bet)
          if (resolution.status === 'confirmed') {
            devWarn(
              `[Bets] Pending bet ${bet.id.slice(0, 20)}... confirmed${resolution.transactionId && resolution.transactionId !== bet.id ? ` as ${resolution.transactionId.slice(0, 20)}...` : ''}`
            )
            confirmed.push({ pendingId: bet.id, confirmedTxId: resolution.transactionId })
          } else if (resolution.status === 'rejected') {
            devWarn(`[Bets] Pending bet ${bet.id.slice(0, 20)}... was rejected → removing`)
            rejected.push(bet.id)
          }
        } catch (err) {
          devWarn(`[Bets] Pending bet ${bet.id.slice(0, 20)}... still unresolved`, err)
        }
      }

      for (const item of confirmed) {
        get().confirmPendingBet(item.pendingId, item.confirmedTxId)
        const activeId = item.confirmedTxId || item.pendingId
        const activeBet = useBetsStore.getState().userBets.find(b => b.id === activeId)
        if (activeBet) {
          refreshSharesFromWallet(activeBet, get, set)
        }
      }

      for (const betId of rejected) {
        get().removePendingBet(betId)
      }

      if (confirmed.length > 0 || rejected.length > 0) {
        devWarn(
          `[Bets] Reconciled pending bets: ${confirmed.length} confirmed, ${rejected.length} rejected`
        )
      }
    }

    // --- Repair legacy false-active bets whose original tx was actually rejected ---
    const rejectedActiveBetIds: string[] = []
    for (const bet of get().userBets) {
      if (bet.status !== 'active' || bet.type === 'sell' || !bet.id.startsWith('0x')) continue
      try {
        const diagnosis = await diagnoseTransaction(bet.id)
        if (diagnosis.status === 'rejected') {
          rejectedActiveBetIds.push(bet.id)
        }
      } catch {
        // Keep bet unchanged if diagnosis is temporarily unavailable.
      }
    }

    if (rejectedActiveBetIds.length > 0) {
      devWarn(`[Bets] Removing ${rejectedActiveBetIds.length} legacy active bet(s) whose tx was rejected on-chain`)
      for (const betId of rejectedActiveBetIds) {
        get().removePendingBet(betId)
      }
    }

    // --- Sync active bet statuses with market state ---
    // Sell bets are already settled (shares burned, tokens received) — skip them.
    const bets = get().userBets
    const activeBets = bets.filter(b => b.status === 'active' && b.type !== 'sell')
    if (activeBets.length === 0) return

    // Get unique market IDs (only real on-chain markets ending with 'field')
    const marketIds = [...new Set(activeBets.map(b => b.marketId))]
      .filter(id => id.startsWith('0x'))

    const updates: Array<{ betId: string; newStatus: Bet['status']; payoutAmount?: bigint; winningOutcome?: string }> = []

    for (const marketId of marketIds) {
      try {
        const market = await getMarket(marketId)
        if (!market) continue

        const marketBets = activeBets.filter(b => b.marketId === marketId)

        if (market.status === 4) {
          // CANCELLED → eligible for refund
          for (const bet of marketBets) {
            updates.push({ betId: bet.id, newStatus: 'refunded' })
          }
        } else if (market.status === 3) {
          // RESOLVED → check winning outcome
          const resolution = await getMarketResolution(marketId)
          if (!resolution) continue

          const winningOutcome = outcomeToString(resolution.winning_outcome)

          for (const bet of marketBets) {
            if (bet.outcome === winningOutcome) {
              // FPMM: winning shares redeem 1:1 (payout = number of shares)
              const payoutAmount = bet.sharesReceived || bet.amount
              updates.push({ betId: bet.id, newStatus: 'won', payoutAmount, winningOutcome })
            } else {
              updates.push({ betId: bet.id, newStatus: 'lost', winningOutcome })
            }
          }
        }
        // Status 1 (active) or 2 (closed) → keep as 'active'
      } catch (err) {
        console.error(`Failed to sync status for market ${marketId}:`, err)
      }
    }

    if (updates.length > 0) {
      const updatedBets = bets.map(bet => {
        const update = updates.find(u => u.betId === bet.id)
        if (!update) return bet
        return {
          ...bet,
          status: update.newStatus,
          payoutAmount: update.payoutAmount,
          winningOutcome: update.winningOutcome,
        }
      })
      set({ userBets: updatedBets })
      saveBetsToStorage(updatedBets)
    }
  },

  markBetClaimed: (betId: string) => {
    const updatedBets = get().userBets.map(bet =>
      bet.id === betId ? { ...bet, claimed: true } : bet
    )
    set({ userBets: updatedBets })
    saveBetsToStorage(updatedBets)
  },

  markBetUnclaimed: (betId: string) => {
    const updatedBets = get().userBets.map(bet =>
      bet.id === betId ? { ...bet, claimed: false } : bet
    )
    set({ userBets: updatedBets })
    saveBetsToStorage(updatedBets)
  },

  reconcileClaimedBets: async () => {
    const { connected, address } = useWalletStore.getState().wallet
    if (!connected || !address) return 0

    const claimedBets = get().userBets.filter(bet =>
      bet.claimed
      && bet.type !== 'sell'
      && (bet.status === 'won' || bet.status === 'refunded')
    )

    if (claimedBets.length === 0) return 0

    // On Ethereum, share balances are in FHE contract state — no client-side record scanning.
    // Bet status is already tracked locally via tx receipts.
    void claimedBets
    return 0
  },

  getBetsByMarket: (marketId) => {
    return get().userBets.filter(bet => bet.marketId === marketId)
  },

  getTotalBetsValue: () => {
    return get().userBets.reduce((total, bet) => total + bet.amount, 0n)
  },

  // Flush all local bet data to Supabase with encryption.
  // Called by WalletBridge after encryption key is derived to ensure
  // no plaintext data leaks into the database.
  flushToSupabase: async () => {
    const { address, encryptionKey } = useWalletStore.getState().wallet
    if (!address || !isSupabaseAvailable()) return

    const { userBets, pendingBets, commitmentRecords } = get()
    devWarn(`[Bets] Flushing to Supabase: ${userBets.length} bets, ${pendingBets.length} pending, ${commitmentRecords.length} commitments`)

    try {
      await Promise.all([
        userBets.length > 0 ? sbUpsertBets(userBets, address, encryptionKey) : Promise.resolve(),
        pendingBets.length > 0 ? sbUpsertPendingBets(pendingBets, address, encryptionKey) : Promise.resolve(),
        commitmentRecords.length > 0 ? sbUpsertCommitments(commitmentRecords, address, encryptionKey) : Promise.resolve(),
      ])
      devWarn('[Bets] Supabase flush complete')
    } catch (err) {
      devWarn('[Bets] Supabase flush failed:', err)
    }
  },
}))

// ============================================================================
// UI Store (for persistent preferences)
// ============================================================================

interface UIStore {
  theme: 'dark'
  sidebarOpen: boolean
  notificationsEnabled: boolean

  // Actions
  setTheme: (_theme: 'dark' | 'light') => void
  toggleTheme: () => void
  toggleSidebar: () => void
  setNotificationsEnabled: (enabled: boolean) => void
}

/** Apply theme class to <html> element */
function applyThemeToDOM() {
  const root = document.documentElement
  root.classList.add('dark')
  root.classList.remove('light')
  root.style.colorScheme = 'dark'
}

export const useUIStore = create<UIStore>()(
  persist(
    (set: (partial: Partial<UIStore>) => void, get: () => UIStore) => ({
      theme: 'dark' as const,
      sidebarOpen: true,
      notificationsEnabled: true,

      setTheme: (_theme: 'light' | 'dark') => {
        applyThemeToDOM()
        set({ theme: 'dark' })
      },
      toggleTheme: () => {
        applyThemeToDOM()
        set({ theme: 'dark' })
      },
      toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
      setNotificationsEnabled: (enabled: boolean) => set({ notificationsEnabled: enabled }),
    }),
    {
      name: 'fhenix-markets-ui',
    }
  )
)

// ============================================================================
// Category Labels
// ============================================================================

export const CATEGORY_LABELS: Record<number, string> = {
  1: 'Politics',
  2: 'Sports',
  3: 'Crypto',
  4: 'Culture',
  5: 'AI & Tech',
  6: 'Macro',
  7: 'Science',
  8: 'Climate',
  99: 'Other',
}

export const CATEGORY_ICONS: Record<number, string> = {
  1: '🏛',
  2: '⚽',
  3: '₿',
  4: '🎭',
  5: '🤖',
  6: '📈',
  7: '🔬',
  8: '🌍',
  99: '🔮',
}
