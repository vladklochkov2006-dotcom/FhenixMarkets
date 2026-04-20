// ============================================================================
// CONTRACTS — Ethers.js integration with FhenixMarkets + FhenixGovernance
// ============================================================================
// All reads use a public JsonRpcProvider (no wallet).
// All writes use the Privy signer via window.__privyGetSigner().
// ============================================================================

import { ethers, Contract, JsonRpcProvider, BrowserProvider } from 'ethers'
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/web'
import { Encryptable } from '@cofhe/sdk'
import { chains as cofheChains } from '@cofhe/sdk/chains'
import { createPublicClient, createWalletClient, custom, http } from 'viem'
import { sepolia } from 'viem/chains'
import FhenixMarketsArtifact from './abis/FhenixMarkets.json'
import FhenixGovernanceArtifact from './abis/FhenixGovernance.json'

const FhenixMarketsABI = FhenixMarketsArtifact.abi
const FhenixGovernanceABI = FhenixGovernanceArtifact.abi
import { devLog, devWarn } from './logger'

// ============================================================================
// ADDRESSES & CHAIN
// ============================================================================

export const FHENIX_MARKETS_ADDRESS = '0x5CDd4A82Ec52E2009072d21DF8EF233841de607B'
export const FHENIX_GOVERNANCE_ADDRESS = '0x75042ED84d417a4c897ACf1f4112467bC041d6a3'
export const SEPOLIA_CHAIN_ID = 11155111
export const SEPOLIA_RPC_URL = 'https://ethereum-sepolia.publicnode.com'

// ============================================================================
// TX RECEIPT HELPER — wait with timeout + fallback to public RPC
// ============================================================================

const TX_TIMEOUT_MS = 90_000 // 90 seconds

async function waitForReceipt(tx: ethers.TransactionResponse): Promise<ethers.TransactionReceipt> {
  try {
    const receipt = await Promise.race([
      tx.wait(1),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('__timeout__')), TX_TIMEOUT_MS)
      ),
    ])
    if (receipt) return receipt
  } catch (err: any) {
    if (err?.message !== '__timeout__') throw err
    devLog('[contracts] tx.wait timed out, polling public RPC for receipt...')
  }
  // Fallback: poll the public RPC for the receipt
  const pub = getReadonlyProvider()
  for (let i = 0; i < 30; i++) {
    const receipt = await pub.getTransactionReceipt(tx.hash)
    if (receipt) return receipt
    await new Promise(r => setTimeout(r, 3000))
  }
  throw new Error(`Transaction sent (${tx.hash}) but receipt not found after timeout. Check Etherscan.`)
}

// ============================================================================
// CONSTANTS (matching Solidity)
// ============================================================================

export const MARKET_STATUS = {
  OPEN: 1,
  CLOSED: 2,
  RESOLVED: 3,
  CANCELLED: 4,
} as const

export const FEES = {
  PROTOCOL_FEE_BPS: 50,      // 0.5%
  CREATOR_FEE_BPS: 50,       // 0.5%
  LP_FEE_BPS: 100,           // 1.0%
  MIN_VOTER_BOND: ethers.parseEther('0.001'),
  DISPUTE_MULTIPLIER: 3,
} as const

export const MIN_TRADE_AMOUNT = ethers.parseEther('0.0001') // 0.0001 ETH

// ============================================================================
// PROVIDER / SIGNER
// ============================================================================

let _readonlyProvider: JsonRpcProvider | null = null

/** Get a read-only provider (no wallet needed) */
export function getReadonlyProvider(): JsonRpcProvider {
  if (!_readonlyProvider) {
    _readonlyProvider = new JsonRpcProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID)
  }
  return _readonlyProvider
}

/** Get the Privy signer (requires connected wallet) */
export async function getSigner(): Promise<ethers.Signer> {
  const getSignerFn = (window as any).__privyGetSigner
  if (typeof getSignerFn !== 'function') {
    throw new Error('Wallet not connected. Please connect via Privy.')
  }
  return await getSignerFn()
}

/** Get the Privy provider */
export async function getProvider(): Promise<BrowserProvider> {
  const getProviderFn = (window as any).__privyGetProvider
  if (typeof getProviderFn !== 'function') {
    throw new Error('Wallet not connected. Please connect via Privy.')
  }
  return await getProviderFn()
}

/** Ensure @cofhe/sdk is initialized for encryption (3-step flow) */
let _cofheClient: any = null
export async function ensureCofheInitialized(): Promise<any> {
  if (_cofheClient) return _cofheClient

  const provider = await getProvider()
  const network = await provider.getNetwork()
  if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
    await ensureSepoliaNetwork()
  }

  // Step 1: Create config using @cofhe/sdk's sepolia chain (with coFheUrl etc.)
  const config = createCofheConfig({
    supportedChains: [cofheChains.sepolia],
  })

  // Step 2: Create client
  const client = createCofheClient(config)

  // Step 3: Connect viem clients
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(SEPOLIA_RPC_URL),
  })

  const walletClient = createWalletClient({
    chain: sepolia,
    transport: custom((window as any).ethereum),
  })

  await client.connect(publicClient, walletClient)

  _cofheClient = client
  _devLog('[contracts] @cofhe/sdk initialized')
  return _cofheClient
}

// ============================================================================
// DECRYPT CACHE — reduces wallet popups for repeated permit requests
// ============================================================================
// Ciphertext hashes are deterministic for the same encrypted value, so caching
// decrypted results during a session is safe. Invalidated automatically when
// the on-chain handle changes (e.g. after buy/sell mutates the balance).

const VIEW_CACHE_TTL_MS = 5 * 60_000 // 5 min
const _decryptViewCache = new Map<string, { value: bigint; expires: number }>()
const _decryptTxCache = new Map<string, { plaintext: bigint; signature: string; expires: number }>()

export function clearDecryptCache(): void {
  _decryptViewCache.clear()
  _decryptTxCache.clear()
}

/**
 * Decrypt a value for viewing (off-chain).
 * Uses the @cofhe/sdk builder pattern and auto-handles permits.
 * Results are cached for 5 minutes per ciphertext handle to reduce wallet popups.
 */
export async function decryptView(encryptedValue: string): Promise<bigint> {
  const now = Date.now()
  const cached = _decryptViewCache.get(encryptedValue)
  if (cached && cached.expires > now) return cached.value

  const client = await ensureCofheInitialized()
  const result = await client.decryptForView(encryptedValue).execute()
  const value = BigInt(result)
  _decryptViewCache.set(encryptedValue, { value, expires: now + VIEW_CACHE_TTL_MS })
  return value
}

/**
 * Decrypt a value for posting on-chain (threshold reveal).
 * Returns both the plaintext and the threshold signature.
 * Signatures are cached per ciphertext handle for the session.
 */
export async function decryptTx(encryptedValue: string): Promise<{ plaintext: bigint, signature: string }> {
  const now = Date.now()
  const cached = _decryptTxCache.get(encryptedValue)
  if (cached && cached.expires > now) {
    return { plaintext: cached.plaintext, signature: cached.signature }
  }

  const client = await ensureCofheInitialized()
  const { decryptedValue, signature } = await client.decryptForTx(encryptedValue).execute()
  const plaintext = BigInt(decryptedValue)
  _decryptTxCache.set(encryptedValue, { plaintext, signature, expires: now + VIEW_CACHE_TTL_MS })
  return { plaintext, signature }
}

function _devLog(msg: string, ...args: any[]) {
  console.log(msg, ...args)
}

// ============================================================================
// CONTRACT INSTANCES
// ============================================================================

/** FhenixMarkets contract (read-only, no signer) */
export function getMarketsRead(): Contract {
  return new Contract(FHENIX_MARKETS_ADDRESS, FhenixMarketsABI, getReadonlyProvider())
}

/** FhenixMarkets contract (with signer for writes) */
export async function getMarketsWrite(): Promise<Contract> {
  const signer = await getSigner()
  return new Contract(FHENIX_MARKETS_ADDRESS, FhenixMarketsABI, signer)
}

/** FhenixGovernance contract (read-only) */
export function getGovernanceRead(): Contract {
  return new Contract(FHENIX_GOVERNANCE_ADDRESS, FhenixGovernanceABI, getReadonlyProvider())
}

/** FhenixGovernance contract (with signer for writes) */
export async function getGovernanceWrite(): Promise<Contract> {
  const signer = await getSigner()
  return new Contract(FHENIX_GOVERNANCE_ADDRESS, FhenixGovernanceABI, signer)
}

// ============================================================================
// TYPE INTERFACES (matching Solidity structs)
// ============================================================================

export interface MarketData {
  questionHash: string    // bytes32
  creator: string         // address
  category: number        // uint8
  numOutcomes: number     // uint8
  deadline: bigint        // uint64
  resolutionDeadline: bigint // uint64
  status: number          // uint8
  createdAt: bigint       // uint64
  resolver: string        // address
}

export interface PoolData {
  reserves: bigint[]      // uint128[4]
  totalLiquidity: bigint  // uint128
  totalLPShares: bigint   // uint128
  totalVolume: bigint     // uint128
}

export interface VoteTallyData {
  winningOutcome: number  // uint8
  votingDeadline: bigint  // uint64
  disputeDeadline: bigint // uint64
  totalBonded: bigint     // uint128
  totalVoters: number     // uint8
  finalized: boolean
  decryptionRequested: boolean
  encOutcome1Bonds: string
  encOutcome2Bonds: string
  encOutcome3Bonds: string
  encOutcome4Bonds: string
}

export interface PriceData {
  prices: bigint[]        // uint128[4] — scaled by 1e18
}

export interface MarketFees {
  protocolFees: bigint
  creatorFees: bigint
}

// ============================================================================
// READ FUNCTIONS — Markets
// ============================================================================

export async function fetchMarket(marketId: string): Promise<MarketData | null> {
  try {
    const c = getMarketsRead()
    const m = await c.getMarket(marketId)
    return {
      questionHash: m.questionHash,
      creator: m.creator,
      category: Number(m.category),
      numOutcomes: Number(m.numOutcomes),
      deadline: BigInt(m.deadline),
      resolutionDeadline: BigInt(m.resolutionDeadline),
      status: Number(m.status),
      createdAt: BigInt(m.createdAt),
      resolver: m.resolver,
    }
  } catch (err) {
    devWarn('[contracts] fetchMarket failed:', err)
    return null
  }
}

export async function fetchPool(marketId: string): Promise<PoolData | null> {
  try {
    const c = getMarketsRead()
    const p = await c.getPool(marketId)
    return {
      reserves: [BigInt(p.reserve_1), BigInt(p.reserve_2), BigInt(p.reserve_3), BigInt(p.reserve_4)],
      totalLiquidity: BigInt(p.totalLiquidity),
      totalLPShares: BigInt(p.totalLPShares),
      totalVolume: BigInt(p.totalVolume),
    }
  } catch (err) {
    devWarn('[contracts] fetchPool failed:', err)
    return null
  }
}

export async function fetchPrices(marketId: string): Promise<number[]> {
  try {
    const c = getMarketsRead()
    const [p1, p2, p3, p4] = await c.getPrices(marketId)
    // Prices are scaled by 1e18 in the contract
    return [
      Number(BigInt(p1)) / 1e18,
      Number(BigInt(p2)) / 1e18,
      Number(BigInt(p3)) / 1e18,
      Number(BigInt(p4)) / 1e18,
    ]
  } catch (err) {
    devWarn('[contracts] fetchPrices failed:', err)
    return [0.5, 0.5, 0, 0]
  }
}

export async function fetchVoteTally(marketId: string): Promise<VoteTallyData | null> {
  try {
    const c = getMarketsRead()
    const v = await c.voteTallies(marketId)
    return {
      winningOutcome: Number(v.winningOutcome),
      votingDeadline: BigInt(v.votingDeadline),
      disputeDeadline: BigInt(v.disputeDeadline),
      totalBonded: BigInt(v.totalBonded),
      totalVoters: Number(v.totalVoters),
      finalized: v.finalized,
      decryptionRequested: v.decryptionRequested,
      encOutcome1Bonds: v.encOutcome1Bonds.toString(),
      encOutcome2Bonds: v.encOutcome2Bonds.toString(),
      encOutcome3Bonds: v.encOutcome3Bonds.toString(),
      encOutcome4Bonds: v.encOutcome4Bonds.toString(),
    }
  } catch (err) {
    devWarn('[contracts] fetchVoteTally failed:', err)
    return null
  }
}

export async function fetchMarketFees(marketId: string): Promise<MarketFees | null> {
  try {
    const c = getMarketsRead()
    const f = await c.marketFees(marketId)
    return {
      protocolFees: BigInt(f.protocolFees),
      creatorFees: BigInt(f.creatorFees),
    }
  } catch (err) {
    devWarn('[contracts] fetchMarketFees failed:', err)
    return null
  }
}

export async function fetchMarketCount(): Promise<number> {
  try {
    const c = getMarketsRead()
    return Number(await c.marketCount())
  } catch (err) {
    devWarn('[contracts] fetchMarketCount failed:', err)
    return 0
  }
}

export async function fetchProtocolTreasury(): Promise<bigint> {
  try {
    const c = getMarketsRead()
    return BigInt(await c.protocolTreasury())
  } catch (err) {
    devWarn('[contracts] fetchProtocolTreasury failed:', err)
    return 0n
  }
}

// ============================================================================
// READ FUNCTIONS — Unshielding Balances
// ============================================================================

export async function getPublicShareBalance(marketId: string, address: string, outcome: number): Promise<bigint> {
  try {
    const key = ethers.solidityPackedKeccak256(["bytes32", "address", "uint8"], [marketId, address, outcome])
    const c = getMarketsRead()
    return BigInt(await c.publicShareBalances(key))
  } catch (err) {
    return 0n
  }
}

export async function getPublicLPBalance(marketId: string, address: string): Promise<bigint> {
  try {
    const key = ethers.solidityPackedKeccak256(["bytes32", "address"], [marketId, address])
    const c = getMarketsRead()
    return BigInt(await c.publicLPBalances(key))
  } catch (err) {
    return 0n
  }
}

export async function getEncryptedShareBalance(marketId: string, address: string, outcome: number): Promise<string> {
  try {
    const c = getMarketsRead()
    const balance = await c.getEncryptedShareBalance(marketId, address, outcome)
    return balance.toString()
  } catch (err) {
    return '0'
  }
}

export async function getEncryptedLPBalance(marketId: string, address: string): Promise<string> {
  try {
    const c = getMarketsRead()
    const balance = await c.getEncryptedLPBalance(marketId, address)
    return balance.toString()
  } catch (err) {
    return '0'
  }
}

// ============================================================================
// READ FUNCTIONS — Governance
// ============================================================================

export async function fetchProposal(proposalId: string) {
  try {
    const c = getGovernanceRead()
    return await c.getProposal(proposalId)
  } catch (err) {
    devWarn('[contracts] fetchProposal failed:', err)
    return null
  }
}

export async function fetchResolverProfile(address: string) {
  try {
    const c = getGovernanceRead()
    return await c.getResolverProfile(address)
  } catch (err) {
    devWarn('[contracts] fetchResolverProfile failed:', err)
    return null
  }
}

export async function fetchPanel(marketId: string) {
  try {
    const c = getGovernanceRead()
    return await c.getPanel(marketId)
  } catch (err) {
    devWarn('[contracts] fetchPanel failed:', err)
    return null
  }
}

// ============================================================================
// WRITE FUNCTIONS — Unshielding
// ============================================================================

export async function requestUnshieldShares(
  marketId: string,
  outcome: number,
  amount: bigint,
): Promise<{ receipt: ethers.TransactionReceipt, reqId: bigint }> {
  devLog('[contracts] requestUnshieldShares', { marketId, outcome, amount: amount.toString() })
  const c = await getMarketsWrite()
  const tx = await c.requestUnshieldShares(marketId, outcome, amount)
  const receipt = await waitForReceipt(tx)

  let reqId = 0n
  for (const log of (receipt?.logs || [])) {
    try {
      const parsed = c.interface.parseLog(log as unknown as ethers.Log)
      if (parsed?.name === 'UnshieldRequested') {
        reqId = BigInt(parsed.args[0])
      }
    } catch (e) { }
  }
  return { receipt: receipt as ethers.TransactionReceipt, reqId }
}

export async function requestUnshieldLP(
  marketId: string,
  amount: bigint,
): Promise<{ receipt: ethers.TransactionReceipt, reqId: bigint }> {
  devLog('[contracts] requestUnshieldLP', { marketId, amount: amount.toString() })
  const c = await getMarketsWrite()
  const tx = await c.requestUnshieldLP(marketId, amount)
  const receipt = await waitForReceipt(tx)

  let reqId = 0n
  for (const log of (receipt?.logs || [])) {
    try {
      const parsed = c.interface.parseLog(log as unknown as ethers.Log)
      if (parsed?.name === 'UnshieldRequested') {
        reqId = BigInt(parsed.args[0])
      }
    } catch (e) { }
  }
  return { receipt: receipt as ethers.TransactionReceipt, reqId }
}

export async function executeUnshield(
  reqId: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] executeUnshield', { reqId: reqId.toString() })
  const c = await getMarketsWrite()
  const tx = await c.executeUnshield(reqId, { gasLimit: 500000 })
  return await waitForReceipt(tx)
}

// ============================================================================
// WRITE FUNCTIONS — Markets
// ============================================================================

export async function createMarket(
  questionHash: string,
  category: number,
  numOutcomes: number,
  deadline: bigint,
  resolutionDeadline: bigint,
  resolver: string,
  initialLiquidityWei: bigint,
): Promise<ethers.TransactionReceipt> {
  console.log('[contracts] createMarket', { questionHash, category, numOutcomes, deadline: deadline.toString(), value: initialLiquidityWei.toString() })
  const c = await getMarketsWrite()
  console.log('[contracts] contract ready, sending tx...')
  const tx = await c.createMarket(
    questionHash, category, numOutcomes, deadline, resolutionDeadline, resolver,
    { value: initialLiquidityWei }
  )
  console.log('[contracts] tx sent:', tx.hash)
  const receipt = await waitForReceipt(tx)
  console.log('[contracts] receipt received, logs:', receipt.logs.length)
  return receipt
}

export async function buyShares(
  marketId: string,
  outcome: number,
  minSharesOut: bigint,
  amount: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] buyShares', { marketId, outcome, amount: amount.toString() })

  const client = await ensureCofheInitialized()
  const [encryptedOutcome] = await client
    .encryptInputs([Encryptable.uint8(BigInt(outcome))])
    .execute()

  const signer = await getSigner()
  const contract = new Contract(FHENIX_MARKETS_ADDRESS, FhenixMarketsABI, signer)
  const tx = await contract.buyShares(marketId, outcome, encryptedOutcome, minSharesOut, { value: amount })
  return await waitForReceipt(tx)
}

export async function sellShares(
  marketId: string,
  outcome: number,
  sharesToSell: bigint,
  minTokensOut: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] sellShares', { marketId, outcome, sharesToSell: sharesToSell.toString() })
  const c = await getMarketsWrite()
  const tx = await c.sellShares(marketId, outcome, sharesToSell, minTokensOut)
  return await waitForReceipt(tx)
}

export async function addLiquidity(
  marketId: string,
  amountWei: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] addLiquidity', { marketId, amountWei: amountWei.toString() })
  const c = await getMarketsWrite()
  const tx = await c.addLiquidity(marketId, { value: amountWei })
  return await waitForReceipt(tx)
}

export async function withdrawLiquidity(
  marketId: string,
  lpShares: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] withdrawLiquidity', { marketId, lpShares: lpShares.toString() })
  const c = await getMarketsWrite()
  const tx = await c.withdrawLiquidity(marketId, lpShares)
  return await waitForReceipt(tx)
}

export async function closeMarket(marketId: string): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] closeMarket', { marketId })
  const c = await getMarketsWrite()
  const tx = await c.closeMarket(marketId)
  return await waitForReceipt(tx)
}

export async function cancelMarket(marketId: string): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] cancelMarket', { marketId })
  const c = await getMarketsWrite()
  const tx = await c.cancelMarket(marketId)
  return await waitForReceipt(tx)
}

export async function voteOutcome(
  marketId: string,
  outcome: number,
  bondAmount: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] voteOutcome', { marketId, outcome, bondAmount: bondAmount.toString() })

  const client = await ensureCofheInitialized()
  const [encryptedOutcome] = await client
    .encryptInputs([Encryptable.uint8(BigInt(outcome))])
    .execute()

  const signer = await getSigner()
  const contract = new Contract(FHENIX_MARKETS_ADDRESS, FhenixMarketsABI, signer)
  const tx = await contract.voteOutcome(marketId, outcome, encryptedOutcome, { value: bondAmount })
  return await waitForReceipt(tx)
}

export async function requestVoteDecryption(marketId: string): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] requestVoteDecryption', { marketId })
  const c = await getMarketsWrite()
  const tx = await c.requestVoteDecryption(marketId)
  return await waitForReceipt(tx)
}

export async function finalizeVotes(marketId: string): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] finalizeVotes', { marketId })
  const c = await getMarketsWrite()
  const tx = await c.finalizeVotes(marketId)
  return await waitForReceipt(tx)
}

export async function requestVoterDecryption(marketId: string): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] requestVoterDecryption', { marketId })
  const c = await getMarketsWrite()
  const tx = await c.requestVoterDecryption(marketId)
  return await waitForReceipt(tx)
}

export async function revealOutcomeTally(
  marketId: string,
  outcomeIndex: number,
  plaintext: number,
  signature: string
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] revealOutcomeTally', { marketId, outcomeIndex, plaintext })
  const c = await getMarketsWrite()
  const tx = await c.revealOutcomeTally(marketId, outcomeIndex, plaintext, signature)
  return await waitForReceipt(tx)
}

export async function revealUnshieldResult(
  reqId: number,
  plaintext: boolean,
  signature: string
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] revealUnshieldResult', { reqId, plaintext })
  const c = await getMarketsWrite()
  // Convert boolean to 1 or 0 for the uint128 contract parameter
  const tx = await c.revealUnshieldResult(reqId, plaintext ? 1n : 0n, signature)
  return await waitForReceipt(tx)
}

export async function confirmResolution(marketId: string): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] confirmResolution', { marketId })
  const c = await getMarketsWrite()
  const tx = await c.confirmResolution(marketId)
  return await waitForReceipt(tx)
}

export async function disputeResolution(
  marketId: string,
  proposedOutcome: number,
  bondWei: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] disputeResolution', { marketId, proposedOutcome, bondWei: bondWei.toString() })
  const c = await getMarketsWrite()
  const tx = await c.disputeResolution(marketId, proposedOutcome, { value: bondWei })
  return await waitForReceipt(tx)
}

export async function redeemShares(
  marketId: string,
  sharesToRedeem: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] redeemShares', { marketId, sharesToRedeem: sharesToRedeem.toString() })
  const c = await getMarketsWrite()
  const tx = await c.redeemShares(marketId, sharesToRedeem)
  return await waitForReceipt(tx)
}

export async function claimRefund(
  marketId: string,
  outcome: number,
  shares: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] claimRefund', { marketId, outcome, shares: shares.toString() })
  const c = await getMarketsWrite()
  const tx = await c.claimRefund(marketId, outcome, shares)
  return await waitForReceipt(tx)
}

export async function claimLPRefund(
  marketId: string,
  lpShares: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] claimLPRefund', { marketId, lpShares: lpShares.toString() })
  const c = await getMarketsWrite()
  const tx = await c.claimLPRefund(marketId, lpShares)
  return await waitForReceipt(tx)
}

export async function withdrawCreatorFees(marketId: string): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] withdrawCreatorFees', { marketId })
  const c = await getMarketsWrite()
  const tx = await c.withdrawCreatorFees(marketId)
  return await waitForReceipt(tx)
}

export async function claimVoterBond(marketId: string): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] claimVoterBond', { marketId })
  const c = await getMarketsWrite()
  const tx = await c.claimVoterBond(marketId)
  return await waitForReceipt(tx)
}

export async function claimDisputeBond(marketId: string): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] claimDisputeBond', { marketId })
  const c = await getMarketsWrite()
  const tx = await c.claimDisputeBond(marketId)
  return await waitForReceipt(tx)
}

export async function claimVoterReward(): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] claimVoterReward')
  const c = await getMarketsWrite()
  const tx = await c.claimVoterReward()
  return await waitForReceipt(tx)
}

export async function withdrawProtocolFees(amount: bigint): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] withdrawProtocolFees', { amount: amount.toString() })
  const c = await getMarketsWrite()
  const tx = await c.withdrawProtocolFees(amount)
  return await waitForReceipt(tx)
}

// Multisig treasury
export async function initMultisig(s1: string, s2: string, s3: string): Promise<ethers.TransactionReceipt> {
  const c = await getMarketsWrite()
  const tx = await c.initMultisig(s1, s2, s3)
  return await waitForReceipt(tx)
}

export async function proposeTreasuryWithdrawal(recipient: string, amount: bigint): Promise<ethers.TransactionReceipt> {
  const c = await getMarketsWrite()
  const tx = await c.proposeTreasuryWithdrawal(recipient, amount)
  return await waitForReceipt(tx)
}

export async function approveTreasuryProposal(proposalId: string): Promise<ethers.TransactionReceipt> {
  const c = await getMarketsWrite()
  const tx = await c.approveTreasuryProposal(proposalId)
  return await waitForReceipt(tx)
}

export async function executeTreasuryProposal(proposalId: string): Promise<ethers.TransactionReceipt> {
  const c = await getMarketsWrite()
  const tx = await c.executeTreasuryProposal(proposalId)
  return await waitForReceipt(tx)
}

// ============================================================================
// WRITE FUNCTIONS — Governance
// ============================================================================

export async function createProposal(
  proposalType: number,
  target: string,
  payload1: bigint,
  payload2: string,
  stakeWei: bigint,
): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] createProposal', { proposalType, target })
  const c = await getGovernanceWrite()
  const tx = await c.createProposal(proposalType, target, payload1, payload2, { value: stakeWei })
  return await waitForReceipt(tx)
}

export async function voteFor(proposalId: string, amountWei: bigint): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] voteFor', { proposalId })
  const c = await getGovernanceWrite()
  const tx = await c.voteFor(proposalId, { value: amountWei })
  return await waitForReceipt(tx)
}

export async function voteAgainst(proposalId: string, amountWei: bigint): Promise<ethers.TransactionReceipt> {
  devLog('[contracts] voteAgainst', { proposalId })
  const c = await getGovernanceWrite()
  const tx = await c.voteAgainst(proposalId, { value: amountWei })
  return await waitForReceipt(tx)
}

export async function unlockAfterVote(proposalId: string): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.unlockAfterVote(proposalId)
  return await waitForReceipt(tx)
}

export async function finalizeVote(proposalId: string): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.finalizeVote(proposalId)
  return await waitForReceipt(tx)
}

export async function executeGovernance(proposalId: string): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.executeGovernance(proposalId)
  return await waitForReceipt(tx)
}

export async function registerResolver(stakeWei: bigint): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.registerResolver({ value: stakeWei })
  return await waitForReceipt(tx)
}

export async function unstakeResolver(): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.unstakeResolver()
  return await waitForReceipt(tx)
}

export async function delegateVotes(delegate: string, amountWei: bigint): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.delegateVotes(delegate, { value: amountWei })
  return await waitForReceipt(tx)
}

export async function undelegateVotes(delegate: string): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.undelegateVotes(delegate)
  return await waitForReceipt(tx)
}

export async function claimReward(epochId: bigint): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.claimReward(epochId)
  return await waitForReceipt(tx)
}

// Escalation
export async function initiateEscalation(marketId: string, proposedOutcome: number, bondWei: bigint): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.initiateEscalation(marketId, proposedOutcome, { value: bondWei })
  return await waitForReceipt(tx)
}

export async function escalateToCommunity(marketId: string): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.escalateToCommunity(marketId)
  return await waitForReceipt(tx)
}

export async function voteEscalation(marketId: string, support: boolean, amountWei: bigint): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.voteEscalation(marketId, support, { value: amountWei })
  return await waitForReceipt(tx)
}

export async function finalizeEscalation(marketId: string): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.finalizeEscalation(marketId)
  return await waitForReceipt(tx)
}

export async function withdrawEscalationBond(marketId: string): Promise<ethers.TransactionReceipt> {
  const c = await getGovernanceWrite()
  const tx = await c.withdrawEscalationBond(marketId)
  return await waitForReceipt(tx)
}

// ============================================================================
// UTILITY
// ============================================================================

/** Compute a market question hash (matching Solidity keccak256) */
export function computeQuestionHash(questionText: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(questionText))
}

/** Parse ETH amount string to wei bigint */
export function parseEth(amount: string | number): bigint {
  return ethers.parseEther(String(amount))
}

/** Format wei to ETH string */
export function formatEth(wei: bigint, decimals: number = 4): string {
  return Number(ethers.formatEther(wei)).toFixed(decimals)
}

/** Ensure wallet is on Sepolia, request switch if not */
export async function ensureSepoliaNetwork(): Promise<void> {
  try {
    const provider = await getProvider()
    const network = await provider.getNetwork()
    if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
      devWarn('[contracts] Wrong network, switching to Sepolia...')
      const raw = await provider.getSigner()
      await (raw.provider as any).send('wallet_switchEthereumChain', [
        { chainId: '0xaa36a7' } // 11155111 in hex
      ])
    }
  } catch (err) {
    devWarn('[contracts] Network switch failed:', err)
    throw new Error('Please switch to Sepolia network in your wallet.')
  }
}

// Keep old name as alias for backward compat
export const ensureFhenixNetwork = ensureSepoliaNetwork

/** Parse contract revert reason from error */
export function parseContractError(err: any): string {
  const msg = err?.reason || err?.message || String(err)

  // Common revert reasons from our contracts
  if (msg.includes('Market not open')) return 'This market is not open for trading.'
  if (msg.includes('Market deadline passed')) return 'The market deadline has passed.'
  if (msg.includes('Deadline not passed')) return 'The market deadline has not passed yet.'
  if (msg.includes('Below min trade')) return 'Amount is below the minimum trade size.'
  if (msg.includes('Insufficient output')) return 'Price moved too much. Try increasing slippage.'
  if (msg.includes('Only creator')) return 'Only the market creator can do this.'
  if (msg.includes('Only deployer')) return 'Only the contract deployer can do this.'
  if (msg.includes('Already voted')) return 'You have already voted on this market.'
  if (msg.includes('Voting not open')) return 'Voting is not open for this market.'
  if (msg.includes('Not finalized')) return 'The vote has not been finalized yet.'
  if (msg.includes('Already claimed')) return 'You have already claimed this reward.'
  if (msg.includes('user rejected') || msg.includes('ACTION_REJECTED')) return 'Transaction rejected by user.'

  // Generic
  if (msg.includes('execution reverted')) {
    const reason = msg.match(/reason="([^"]+)"/)
    return reason ? reason[1] : 'Transaction failed. Please check your inputs.'
  }

  return msg
}
