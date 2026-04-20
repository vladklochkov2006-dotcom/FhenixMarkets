import { motion } from 'framer-motion'
import {
  Lock,
  Gavel,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Clock,
  ArrowRight,
  Shield,
  Coins,
  Swords,
  RefreshCw,
} from 'lucide-react'
import { useState, useEffect, useMemo } from 'react'
import { type Market, useWalletStore } from '@/lib/store'
import { cn, getTokenSymbol } from '@/lib/utils'
import { devLog, devWarn } from '@/lib/logger'
import {
  closeMarket as contractCloseMarket,
  voteOutcome as contractVoteOutcome,
  disputeResolution as contractDispute,
  confirmResolution as contractConfirmResolution,
  claimVoterBond as contractClaimVoterBond,
  requestVoteDecryption as contractRequestVoteDecryption,
  requestVoterDecryption as contractRequestVoterDecryption,
  revealOutcomeTally as contractRevealOutcomeTally,
  decryptTx,
  parseContractError,
  ensureFhenixNetwork as ensureSepoliaNetwork,
  MARKET_STATUS,
  FEES,
  FHENIX_MARKETS_ADDRESS,
  type VoteTallyData,
} from '@/lib/contracts'
import { ethers } from 'ethers'
import { TransactionLink } from './TransactionLink'

// Local type stub for MarketResolutionData
// Type is now imported from contracts.ts
// MarketResolutionData removed in favor of VoteTallyData

// getCurrentBlockHeight — on Ethereum, use provider to get latest block
const getCurrentBlockHeight = async (): Promise<bigint> => {
  try {
    const provider = new ethers.BrowserProvider((window as any).ethereum)
    return BigInt(await provider.getBlockNumber())
  } catch {
    return BigInt(Math.floor(Date.now() / 1000))
  }
}

// Stub for getProgramIdForToken — not needed on Ethereum but called in bond inspection
function getProgramIdForToken(_tokenType: string = 'ETH'): string {
  return FHENIX_MARKETS_ADDRESS
}

interface ResolvePanelProps {
  market: Market
  resolution: VoteTallyData | null
  onResolutionChange: () => Promise<void>
}

type ResolveStep = 'close' | 'submit' | 'challenge' | 'finalize' | 'done'

// v33 constants (must match contract)
const MIN_VOTE_BOND = ethers.parseEther('0.001')
const BOND_MULTIPLIER = 3n

interface ParsedVoterBondReceipt {
  plaintext: string
  marketId: string | null
  votedOutcome: number | null
  owner: string | null
}

type BondIndicatorStatus = 'idle' | 'wallet_required' | 'checking' | 'claimable' | 'slashed' | 'claimed' | 'missing' | 'error'

interface BondIndicatorState {
  status: BondIndicatorStatus
  receipt: ParsedVoterBondReceipt | null
  message?: string
}

interface MarketReceiptScanResult {
  unspent: ParsedVoterBondReceipt | null
  spent: ParsedVoterBondReceipt | null
}

async function inspectVoterBondReceiptsForMarket(
  _programId: string,
  marketId: string,
  logPrefix: string = '[ClaimBond]',
): Promise<MarketReceiptScanResult> {
  let matchedUnspent: ParsedVoterBondReceipt | null = null
  let matchedSpent: ParsedVoterBondReceipt | null = null
  devLog(`${logPrefix} Ethereum mode: VoterBondReceipt lookup via contract (TODO)`)

  if (!matchedUnspent && !matchedSpent) {
    devLog(`${logPrefix} No VoterBondReceipt found for market:`, marketId)
  }

  return {
    unspent: matchedUnspent,
    spent: matchedSpent,
  }
}

export function ResolvePanel({ market, resolution, onResolutionChange }: ResolvePanelProps) {
  const { wallet } = useWalletStore()

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [transactionId, setTransactionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedOutcome, setSelectedOutcome] = useState<number | null>(null)
  const [currentBlock, setCurrentBlock] = useState<bigint>(0n)
  const [bondIndicator, setBondIndicator] = useState<BondIndicatorState>({ status: 'idle', receipt: null })

  const tokenSymbol = getTokenSymbol('ETH')
  const tokenTypeStr = 'ETH' as const
  const numOutcomes = market.numOutcomes ?? 2
  const outcomeLabels = market.outcomeLabels ?? (numOutcomes === 2 ? ['Yes', 'No'] : Array.from({ length: numOutcomes }, (_, i) => `Outcome ${i + 1}`))

  useEffect(() => {
    let mounted = true
    const fetchBlock = async () => {
      try {
        const height = await getCurrentBlockHeight()
        if (mounted) setCurrentBlock(height)
      } catch {
        // ignore
      }
    }
    fetchBlock()
    const interval = setInterval(fetchBlock, 15_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  const STATUS_PENDING_FINALIZATION = 6
  const currentStep: ResolveStep = useMemo(() => {
    if (market.status === MARKET_STATUS.RESOLVED) return 'done'
    if (market.status === STATUS_PENDING_FINALIZATION) {
      if (resolution && currentBlock > 0n && resolution.disputeDeadline > 0n && currentBlock > resolution.disputeDeadline) {
        return 'finalize'
      }
      return 'challenge'
    }
    if (market.status === 5 /* PENDING_RESOLUTION */) {
      if (resolution && currentBlock > 0n && currentBlock > resolution.disputeDeadline) {
        return 'finalize'
      }
      return 'submit'
    }
    if (market.status === MARKET_STATUS.CLOSED) return 'submit'
    return 'close'
  }, [market.status, resolution, currentBlock])

  const roundInfo = useMemo(() => {
    if (!resolution) return null
    return {
      totalBonded: resolution.totalBonded,
    }
  }, [resolution])

  const minChallengeBond = resolution
    ? resolution.totalBonded * BOND_MULTIPLIER
    : MIN_VOTE_BOND * BOND_MULTIPLIER

  const challengeInfo = useMemo(() => {
    if (!resolution || currentBlock === 0n) return null
    const blocksLeft = resolution.disputeDeadline - currentBlock
    if (blocksLeft <= 0n) return { text: 'Challenge window ended', canFinalize: true, blocksLeft: 0n }
    const secondsLeft = Number(blocksLeft)
    const hours = Math.floor(secondsLeft / 3600)
    const minutes = Math.floor((secondsLeft % 3600) / 60)
    return {
      text: `${hours}h ${minutes}m remaining (${blocksLeft.toString()} blocks)`,
      canFinalize: false,
      blocksLeft,
    }
  }, [resolution, currentBlock])

  useEffect(() => {
    let cancelled = false

    if (currentStep !== 'done' || market.status !== MARKET_STATUS.RESOLVED || !resolution) {
      setBondIndicator({ status: 'idle', receipt: null })
      return () => { cancelled = true }
    }

    if (!wallet.connected || !wallet.address) {
      setBondIndicator({
        status: 'wallet_required',
        receipt: null,
        message: 'Connect your wallet to check whether your bond is claimable or slashed.',
      })
      return () => { cancelled = true }
    }

    setBondIndicator({ status: 'checking', receipt: null })

      ; (async () => {
        try {
          const receipt = await inspectVoterBondReceiptsForMarket(
            getProgramIdForToken('ETH'),
            market.id,
            '[BondStatus]',
          )

          if (cancelled) return

          if (receipt.unspent?.votedOutcome === resolution.winningOutcome) {
            setBondIndicator({ status: 'claimable', receipt: receipt.unspent })
            return
          }

          if (receipt.unspent) {
            setBondIndicator({ status: 'slashed', receipt: receipt.unspent })
            return
          }

          if (receipt.spent) {
            setBondIndicator({
              status: 'claimed',
              receipt: receipt.spent,
              message: 'This bond receipt has already been spent in a successful claim.',
            })
            return
          }

          if (!receipt.unspent && !receipt.spent) {
            setBondIndicator({
              status: 'missing',
              receipt: null,
              message: 'This wallet does not have a VoterBondReceipt for this market.',
            })
            return
          }
        } catch (err) {
          if (cancelled) return
          console.error('[BondStatus] Failed to inspect voter bond receipt:', err)
          setBondIndicator({
            status: 'error',
            receipt: null,
            message: 'Bond status could not be checked automatically. Try reconnecting your wallet and refreshing the page.',
          })
        }
      })()

    return () => { cancelled = true }
  }, [
    currentStep,
    market.id,
    market.status,
    resolution,
    tokenTypeStr,
    wallet.connected,
    wallet.address,
  ])

  const steps: { key: ResolveStep; label: string; icon: React.ElementType }[] = [
    { key: 'close', label: 'Close', icon: Lock },
    { key: 'submit', label: 'Submit', icon: Gavel },
    { key: 'challenge', label: 'Dispute', icon: Shield },
    { key: 'finalize', label: 'Finalize', icon: CheckCircle2 },
  ]

  const handleCloseMarket = async () => {
    setIsSubmitting(true)
    setError(null)
    try {
      await ensureSepoliaNetwork()
      const receipt = await contractCloseMarket(market.id)
      setTransactionId(receipt.hash)
      onResolutionChange?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? parseContractError(err) : 'Failed to close market')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSubmitOutcome = async () => {
    if (!selectedOutcome) return
    setIsSubmitting(true)
    setError(null)
    try {
      if (!wallet.address) {
        throw new Error('Wallet address not available. Reconnect your wallet and try again.')
      }

      await ensureSepoliaNetwork()

      const bondWei = FEES.MIN_VOTER_BOND

      const receipt = await contractVoteOutcome(market.id, selectedOutcome, bondWei)
      setTransactionId(receipt.hash)
      onResolutionChange?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? parseContractError(err) : 'Failed to submit outcome')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleChallengeOutcome = async () => {
    if (!selectedOutcome) return
    setIsSubmitting(true)
    setError(null)
    try {
      if (!wallet.address) {
        throw new Error('Wallet address not available. Reconnect your wallet and try again.')
      }

      await ensureSepoliaNetwork()

      const bondWei = minChallengeBond

      const receipt = await contractDispute(market.id, selectedOutcome, bondWei)
      setTransactionId(receipt.hash)
      onResolutionChange?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? parseContractError(err) : 'Failed to challenge outcome')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleFinalizeOutcome = async () => {
    setIsSubmitting(true)
    setError(null)
    try {
      await ensureSepoliaNetwork()

      if (market.status === STATUS_PENDING_FINALIZATION) {
        const receipt = await contractConfirmResolution(market.id)
        setTransactionId(receipt.hash)
        onResolutionChange?.()
        return
      }

      if (!resolution) {
        throw new Error('Resolution data not loaded')
      }

      // Step 1: Request Decryption
      if (!resolution.decryptionRequested) {
        devLog('[Resolve] Step 1: Requesting decryption...')
        const receipt = await contractRequestVoteDecryption(market.id)
        setTransactionId(receipt.hash)
        onResolutionChange?.()
        return
      }

      // Step 2: Threshold Reveal (if winning outcome is 0, it means it's not reveal-finalized)
      if (resolution.winningOutcome === 0) {
        devLog('[Resolve] Step 2: Performing threshold reveal...')
        const tallies = [
          resolution.encOutcome1Bonds,
          resolution.encOutcome2Bonds,
          resolution.encOutcome3Bonds,
          resolution.encOutcome4Bonds
        ]

        // Reveal the first outcome that isn't publicly revealed yet
        // In a real app, you might want a loop or a smarter check, 
        // but for now we'll reveal each outcome that has a tally.
        for (let i = 0; i < market.numOutcomes; i++) {
          const encTally = tallies[i]
          if (encTally && encTally !== '0') {
             devLog(`[Resolve] Decrypting tally for outcome ${i+1}...`)
             const { plaintext, signature } = await decryptTx(encTally)
             const receipt = await contractRevealOutcomeTally(market.id, i, plaintext, signature)
             setTransactionId(receipt.hash)
             onResolutionChange?.()
             return // Wait for confirmation before next reveal or finalize
          }
        }
      }

      // Step 3: Finalize
      devLog('[Resolve] Step 3: Finalizing votes...')
      const receipt = await contractFinalizeVotes(market.id)
      setTransactionId(receipt.hash)
      onResolutionChange?.()
    } catch (err: unknown) {
      devWarn('[Resolve] Finalize failed:', err)
      setError(err instanceof Error ? parseContractError(err) : 'Failed to finalize outcome')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClaimVoterBond = async () => {
    devLog('[ClaimBond] Starting claim for market:', market.id)
    setIsSubmitting(true)
    setError(null)
    try {
      await ensureSepoliaNetwork()
      const receipt = await contractClaimVoterBond(market.id)
      setTransactionId(receipt.hash)
      onResolutionChange?.()
    } catch (err: unknown) {
      devWarn('[ClaimBond] Error:', err)
      const msg = parseContractError(err)
      if (msg.includes('Not decrypted')) {
        setError('Voter choice not decrypted yet. Requesting decryption...')
        try {
          const r2 = await contractRequestVoterDecryption(market.id)
          setTransactionId(r2.hash)
          onResolutionChange?.()
        } catch (e2) {
          setError(parseContractError(e2))
        }
      } else {
        setError(msg)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const resetState = () => {
    setTransactionId(null)
    setError(null)
    setSelectedOutcome(null)
    onResolutionChange?.()
  }

  const outcomeColors = [
    'bg-yes-500/10 border-yes-500/30 text-yes-400',
    'bg-no-500/10 border-no-500/30 text-no-400',
    'bg-purple-500/10 border-purple-500/30 text-purple-400',
    'bg-brand-500/10 border-brand-500/30 text-brand-400',
  ]
  const votedOutcomeLabel = bondIndicator.receipt?.votedOutcome
    ? outcomeLabels[bondIndicator.receipt.votedOutcome - 1] || `Outcome ${bondIndicator.receipt.votedOutcome}`
    : null
  const winningOutcomeLabel = resolution?.winningOutcome
    ? outcomeLabels[resolution.winningOutcome - 1] || `Outcome ${resolution.winningOutcome}`
    : null
  const claimButtonDisabled = isSubmitting
    || !wallet.address
    || bondIndicator.status === 'checking'
    || bondIndicator.status === 'slashed'
    || bondIndicator.status === 'claimed'

  return (
    <div className="glass-card overflow-hidden">
      <div className="p-6 border-b border-white/[0.04]">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center">
            <Gavel className="w-5 h-5 text-brand-400" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Open Resolution</h3>
            <p className="text-sm text-brand-300">Market Resolved</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {steps.map((s, idx) => {
            const StepIcon = s.icon
            const stepOrder = ['close', 'submit', 'challenge', 'finalize', 'done']
            const currentIdx = stepOrder.indexOf(currentStep)
            const stepIdx = stepOrder.indexOf(s.key)
            const isComplete = currentStep === 'done' || stepIdx < currentIdx
            const isCurrent = currentStep === s.key || (currentStep === 'challenge' && s.key === 'challenge')
            return (
              <div key={s.key} className="flex items-center gap-1 flex-1">
                <div className={cn(
                  'flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium flex-1',
                  isComplete ? 'bg-yes-500/10 text-yes-400' :
                    isCurrent ? 'bg-brand-500/10 text-brand-400 ring-1 ring-brand-500/30' :
                      'bg-white/[0.02] text-surface-500'
                )}>
                  <StepIcon className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{s.label}</span>
                </div>
                {idx < steps.length - 1 && (
                  <ArrowRight className={cn(
                    'w-3 h-3 flex-shrink-0',
                    isComplete ? 'text-yes-500' : 'text-surface-700'
                  )} />
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="p-6">
        {transactionId ? (
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center">
            <div className="w-16 h-16 rounded-full bg-yes-500/20 mx-auto mb-4 flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8 text-yes-400" />
            </div>
            <h4 className="text-lg font-semibold text-white mb-2">Transaction Submitted</h4>
            <p className="text-sm text-surface-400 mb-3">Please wait for on-chain confirmation (1-3 minutes).</p>
            <TransactionLink transactionId={transactionId} className="mb-4" showCopy={true} showNote={true} />
            <button onClick={resetState} className="btn-secondary w-full mt-4">Continue</button>
          </motion.div>
        ) : currentStep === 'done' ? (
          <div className="space-y-4">
            <div className="text-center py-4">
              <div className="w-14 h-14 rounded-full bg-yes-500/10 flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 className="w-7 h-7 text-yes-400" />
              </div>
              <h4 className="text-lg font-semibold text-white mb-1">Market Resolved</h4>
              {resolution && (
                <p className="text-surface-400 text-sm">
                  Winning outcome: <span className="text-white font-medium">
                    {outcomeLabels[resolution.winningOutcome - 1] || `Outcome ${resolution.winningOutcome}`}
                  </span>
                </p>
              )}
            </div>

            <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.04] space-y-3">
              <div className="flex items-center gap-2">
                <Coins className="w-4 h-4 text-brand-400" />
                <span className="text-sm font-medium text-white">Claim Voter Bond</span>
              </div>
              <p className="text-xs text-surface-400">
                If you voted on the winning outcome, claim your 1 ETH bond back.
                Wrong voters' bonds are forfeited (slashed).
              </p>
              {bondIndicator.status === 'checking' && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-brand-500/5 border border-brand-500/20">
                  <Loader2 className="w-4 h-4 text-brand-400 flex-shrink-0 mt-0.5 animate-spin" />
                  <div>
                    <p className="text-xs font-medium text-brand-300">Checking bond status...</p>
                    <p className="text-xs text-surface-400 mt-1">We are looking for the vote receipt for this market in your wallet.</p>
                  </div>
                </div>
              )}
              {bondIndicator.status === 'claimable' && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-yes-500/5 border border-yes-500/20">
                  <CheckCircle2 className="w-4 h-4 text-yes-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-yes-300">Bond can be claimed</p>
                    <p className="text-xs text-surface-400 mt-1">
                      Your vote: <span className="text-white">{votedOutcomeLabel}</span>. Final outcome: <span className="text-white">{winningOutcomeLabel}</span>.
                    </p>
                  </div>
                </div>
              )}
              {bondIndicator.status === 'slashed' && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-no-500/5 border border-no-500/20">
                  <AlertCircle className="w-4 h-4 text-no-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-no-300">Bond was slashed</p>
                    <p className="text-xs text-surface-400 mt-1">
                      Your vote: <span className="text-white">{votedOutcomeLabel}</span>. Final outcome: <span className="text-white">{winningOutcomeLabel}</span>.
                    </p>
                  </div>
                </div>
              )}
              {bondIndicator.status === 'claimed' && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-yes-500/5 border border-yes-500/20">
                  <CheckCircle2 className="w-4 h-4 text-yes-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-yes-300">Bond already claimed</p>
                    <p className="text-xs text-surface-400 mt-1">
                      Your vote: <span className="text-white">{votedOutcomeLabel}</span>. Final outcome: <span className="text-white">{winningOutcomeLabel}</span>.
                    </p>
                  </div>
                </div>
              )}
              {bondIndicator.status === 'wallet_required' && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-brand-500/5 border border-brand-500/20">
                  <Shield className="w-4 h-4 text-brand-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-brand-300">Connect wallet to check bond</p>
                    <p className="text-xs text-surface-400 mt-1">{bondIndicator.message}</p>
                  </div>
                </div>
              )}
              {bondIndicator.status === 'missing' && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-brand-500/5 border border-brand-500/20">
                  <AlertCircle className="w-4 h-4 text-brand-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-brand-300">Bond receipt not found</p>
                    <p className="text-xs text-surface-400 mt-1">
                      {bondIndicator.message} If you are sure you voted, try reconnecting your wallet and refreshing the page.
                    </p>
                  </div>
                </div>
              )}
              {bondIndicator.status === 'error' && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-brand-500/5 border border-brand-500/20">
                  <AlertCircle className="w-4 h-4 text-brand-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-brand-300">Bond status not yet verified</p>
                    <p className="text-xs text-surface-400 mt-1">{bondIndicator.message}</p>
                  </div>
                </div>
              )}
              {roundInfo && (
                <div className="flex justify-between text-xs text-surface-500">
                  <span>Total Bonded</span>
                  <span className="text-white font-mono">{Number(roundInfo.totalBonded) / 1e18} ETH</span>
                </div>
              )}
              <button
                onClick={handleClaimVoterBond}
                disabled={claimButtonDisabled}
                className={cn(
                  'w-full flex items-center justify-center gap-2 btn-primary',
                  claimButtonDisabled && 'opacity-60 cursor-not-allowed',
                )}
              >
                {isSubmitting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /><span>Claiming...</span></>
                ) : bondIndicator.status === 'checking' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /><span>Checking Bond...</span></>
                ) : bondIndicator.status === 'slashed' ? (
                  <><AlertCircle className="w-4 h-4" /><span>Bond Slashed</span></>
                ) : bondIndicator.status === 'claimed' ? (
                  <><CheckCircle2 className="w-4 h-4" /><span>Bond Claimed</span></>
                ) : !wallet.address ? (
                  <><Shield className="w-4 h-4" /><span>Connect Wallet</span></>
                ) : (
                  <><Coins className="w-4 h-4" /><span>Claim 1 ETH Bond</span></>
                )}
              </button>
            </div>

            <p className="text-xs text-surface-500 text-center">
              Winners can also redeem shares 1:1 for {tokenSymbol} in the Trade tab.
            </p>
          </div>
        ) : (
          <>
            {currentStep === 'close' && (
              <div className="space-y-4">
                <div className="flex items-start gap-3 p-4 rounded-xl bg-white/[0.02]">
                  <Lock className="w-5 h-5 text-brand-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-lg font-bold text-white uppercase tracking-tight">VOTING PHASE</p>
                    <p className="text-xs text-surface-400 mt-1">
                      Stops all trading. Anyone can call this after the deadline.
                    </p>
                  </div>
                </div>

                {currentBlock > 0n && market.deadline > 0n && currentBlock <= market.deadline && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-brand-500/10 border border-brand-500/20">
                    <Clock className="w-4 h-4 text-brand-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-brand-300">
                      Trading deadline not passed. Block {currentBlock.toString()} / {market.deadline.toString()}.
                    </p>
                  </div>
                )}

                <button onClick={handleCloseMarket} disabled={isSubmitting} className="w-full flex items-center justify-center gap-2 btn-primary">
                  {isSubmitting ? <><Loader2 className="w-5 h-5 animate-spin" /><span>Confirm in Wallet...</span></> : <><Lock className="w-5 h-5" /><span>Close Market</span></>}
                </button>
              </div>
            )}

            {currentStep === 'submit' && (
              <div className="space-y-4">
                {roundInfo && roundInfo.totalBonded > 0n && (
                  <div className="p-4 rounded-xl bg-white/[0.02] space-y-2">
                    <div className="flex items-center gap-2 mb-2">
                      <Gavel className="w-4 h-4 text-brand-400" />
                      <span className="text-sm font-medium text-white">Voting in Progress</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-surface-400">Total Bonded</span>
                      <span className="text-white font-mono">{Number(roundInfo.totalBonded) / 1e18} ETH</span>
                    </div>
                    {challengeInfo && (
                      <div className="flex justify-between text-sm">
                        <span className="text-surface-400">Voting Deadline</span>
                        <span className={cn('font-medium', challengeInfo.canFinalize ? 'text-yes-400' : 'text-brand-400')}>
                          {challengeInfo.text}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-start gap-3 p-4 rounded-xl bg-white/[0.02]">
                  <Gavel className="w-5 h-5 text-brand-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-white">Vote Outcome</p>
                    <p className="text-xs text-surface-400 mt-1">
                      Anyone can vote on the winning outcome with a <span className="text-white font-medium">1 ETH bond</span>.
                      Minimum 3 voters required. Wrong voters get slashed.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 p-3 rounded-lg bg-brand-500/5 border border-brand-500/20">
                  <Shield className="w-4 h-4 text-brand-400 flex-shrink-0" />
                  <p className="text-xs text-brand-300">
                    Bond: <span className="font-mono font-medium">1 ETH</span> (returned if your outcome wins)
                  </p>
                </div>

                <div>
                  <label className="block text-sm text-surface-400 mb-2">Select Winning Outcome</label>
                  <div className="space-y-2">
                    {outcomeLabels.map((label, i) => {
                      const outcomeNum = i + 1
                      const isSelected = selectedOutcome === outcomeNum
                      const colorIdx = Math.min(i, 3)
                      return (
                        <button key={outcomeNum} onClick={() => setSelectedOutcome(outcomeNum)}
                          className={cn(
                            'w-full p-3 rounded-xl border text-left transition-all flex items-center justify-between',
                            isSelected ? 'bg-brand-500/10 border-brand-500/40 ring-1 ring-brand-500/20' : 'bg-white/[0.02] border-white/[0.06] hover:border-surface-600/50'
                          )}>
                          <span className={cn('px-2 py-0.5 text-xs font-medium rounded-full border', outcomeColors[colorIdx])}>{label}</span>
                          {isSelected && <CheckCircle2 className="w-4 h-4 text-brand-400" />}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <button onClick={handleSubmitOutcome} disabled={isSubmitting || !selectedOutcome}
                  className={cn('w-full flex items-center justify-center gap-2 btn-primary', !selectedOutcome && 'opacity-50 cursor-not-allowed')}>
                  {isSubmitting ? <><Loader2 className="w-5 h-5 animate-spin" /><span>Confirm in Wallet...</span></> : <><Gavel className="w-5 h-5" /><span>{selectedOutcome ? `Submit: ${outcomeLabels[selectedOutcome - 1]} Wins (1 ETH bond)` : 'Select Outcome'}</span></>}
                </button>
              </div>
            )}

            {currentStep === 'challenge' && (
              <div className="space-y-4">
                {roundInfo && (
                  <div className="p-4 rounded-xl bg-white/[0.02] space-y-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Shield className="w-4 h-4 text-purple-400" />
                      <p className="text-lg font-bold text-white uppercase tracking-tight">CHALLENGE WINDOW</p>
                    </div>
                    <p className="text-sm text-surface-400">
                      The community has 24 hours to challenge the outcome.
                    </p>
                    <div className="flex justify-between text-sm">
                      <span className="text-surface-400">Total Voters</span>
                      <span className="text-surface-500 font-mono text-xs">Waiting for Confirmation</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-surface-400">Total Bonded</span>
                      <span className="text-white font-mono">{Number(roundInfo.totalBonded) / 1e18} ETH</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-surface-400">Dispute Deadline</span>
                      <span className={cn('font-medium', challengeInfo?.canFinalize ? 'text-yes-400' : 'text-brand-400')}>
                        {challengeInfo?.text || 'Loading...'}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex items-start gap-2 p-3 rounded-lg bg-yes-500/5 border border-yes-500/20">
                  <CheckCircle2 className="w-4 h-4 text-yes-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-yes-300">
                    Agree with the result? No action needed. After {challengeInfo?.blocksLeft?.toString() || '...'} blocks it will be confirmed and market resolved.
                  </p>
                </div>

                <div className="border-t border-white/[0.04] pt-4">
                  <div className="flex items-start gap-3 p-4 rounded-xl bg-no-500/5 border border-no-500/20 mb-4">
                    <Swords className="w-5 h-5 text-no-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-no-300">Disagree? File a Dispute!</p>
                      <p className="text-xs text-surface-400 mt-1">
                        Override the vote result with <span className="text-white font-medium">{Number(BigInt(roundInfo?.totalBonded || 0) * BOND_MULTIPLIER) / 1e18} ETH bond</span>.
                        If your outcome is correct, you get your bond back + all voter bonds. If wrong, you lose your entire bond.
                      </p>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm text-surface-400 mb-2">Select Correct Outcome</label>
                    <div className="space-y-2">
                      {outcomeLabels.map((label, i) => {
                        const outcomeNum = i + 1
                        const isSelected = selectedOutcome === outcomeNum
                        const colorIdx = Math.min(i, 3)
                        return (
                          <button key={outcomeNum} onClick={() => setSelectedOutcome(outcomeNum)}
                            className={cn(
                              'w-full p-3 rounded-xl border text-left transition-all flex items-center justify-between',
                              isSelected ? 'bg-no-500/10 border-no-500/40 ring-1 ring-no-500/20' : 'bg-white/[0.02] border-white/[0.06] hover:border-surface-600/50'
                            )}>
                            <span className={cn('px-2 py-0.5 text-xs font-medium rounded-full border', outcomeColors[colorIdx])}>{label}</span>
                            {isSelected && <CheckCircle2 className="w-4 h-4 text-no-400" />}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <button onClick={handleChallengeOutcome} disabled={isSubmitting || !selectedOutcome}
                    className={cn('w-full flex items-center justify-center gap-2 mt-4', 'bg-no-500/20 hover:bg-no-500/30 text-no-300 font-medium py-3 rounded-xl transition-colors', !selectedOutcome && 'opacity-50 cursor-not-allowed')}>
                    {isSubmitting ? <><Loader2 className="w-5 h-5 animate-spin" /><span>Confirm in Wallet...</span></> : <><Swords className="w-5 h-5" /><span>{selectedOutcome ? `Dispute: ${outcomeLabels[selectedOutcome - 1]} (${Number(BigInt(roundInfo?.totalBonded || 0) * BOND_MULTIPLIER) / 1e18} ETH)` : 'Select Outcome to Dispute'}</span></>}
                  </button>
                </div>
              </div>
            )}

            {currentStep === 'finalize' && (
              <div className="space-y-4">
                <div className="flex items-start gap-3 p-4 rounded-xl bg-white/[0.02]">
                  <CheckCircle2 className="w-5 h-5 text-purple-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xl font-bold text-white">Current Resolution</p>
                    <p className="text-xs text-surface-400 mt-1">
                      Challenge window ended. Anyone can finalize. The resolver earns 20% of protocol fees as reward.
                    </p>
                  </div>
                </div>

                {roundInfo && resolution && (
                  <div className="p-4 rounded-xl bg-yes-500/5 border border-yes-500/20 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-surface-400">Final Outcome</span>
                      <span className="text-yes-400 font-medium">
                        {outcomeLabels[resolution.winningOutcome - 1] || `Outcome ${resolution.winningOutcome}`}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-surface-400">Resolution Rounds</span>
                      <span className="text-white">N/A</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-surface-400">Total Bonded</span>
                      <span className="text-white font-mono">{Number(roundInfo.totalBonded) / 1e18} ETH</span>
                    </div>
                  </div>
                )}

                <button onClick={handleFinalizeOutcome} disabled={isSubmitting || (resolution?.decryptionRequested && resolution?.winningOutcome === 0)}
                  className={cn('w-full flex items-center justify-center gap-2 btn-primary',
                    (resolution?.decryptionRequested && resolution?.winningOutcome === 0) && 'opacity-60 cursor-wait')}>
                  {isSubmitting ? <><Loader2 className="w-5 h-5 animate-spin" /><span>Confirming...</span></> :
                    (resolution && !resolution.decryptionRequested) ? <><RefreshCw className="w-5 h-5" /><span>Request Vote Decryption</span></> :
                      (resolution && resolution.decryptionRequested && resolution.winningOutcome === 0) ? <><Loader2 className="w-5 h-5 animate-spin" /><span>Decrypting (waiting for coprocessor)...</span></> :
                        <><CheckCircle2 className="w-5 h-5" /><span>Finalize Resolution</span></>}
                </button>
              </div>
            )}
          </>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 p-4 rounded-xl bg-no-500/10 border border-no-500/20 mt-4">
            <AlertCircle className="w-5 h-5 text-no-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-no-400">Action Failed</p>
              <p className="text-sm text-surface-400 mt-1">{error}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
