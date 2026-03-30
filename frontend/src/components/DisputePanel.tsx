import { motion } from 'framer-motion'
import { ShieldAlert, Clock, AlertTriangle, Loader2, Check } from 'lucide-react'
import { useState, useMemo, useEffect } from 'react'
import { type Market } from '@/lib/store'
import { cn, formatCredits } from '@/lib/utils'
import { disputeResolution as contractDispute, parseContractError, ensureSepoliaNetwork } from '@/lib/contracts'
import { ethers } from 'ethers'
import { TransactionLink } from './TransactionLink'
// config import removed — deadlines use timestamps on Ethereum
import { devWarn } from '../lib/logger'

// Local constants (migrated from aleo-client)
const CHALLENGE_WINDOW_BLOCKS = 2880n // ~12 hours
const MIN_DISPUTE_BOND = 1000000n     // 1 token

// getCurrentBlockHeight — on Ethereum, use provider to get latest block
async function getCurrentBlockHeight(): Promise<bigint> {
  try {
    const provider = new ethers.BrowserProvider((window as any).ethereum)
    const blockNumber = await provider.getBlockNumber()
    return BigInt(blockNumber)
  } catch {
    return 0n
  }
}

// Re-export for compatibility
type MarketResolutionData = any

interface DisputePanelProps {
  market: Market
  resolution: MarketResolutionData
}

export function DisputePanel({ market, resolution }: DisputePanelProps) {
  // Contract calls via contracts.ts

  const [proposedOutcome, setProposedOutcome] = useState<number | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [transactionId, setTransactionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [currentBlock, setCurrentBlock] = useState<bigint>(0n)
  const [timeRemaining, setTimeRemaining] = useState<string>('')

  const numOutcomes = market.numOutcomes || 2

  // Fetch current block height for countdown
  useEffect(() => {
    let mounted = true

    const fetchBlock = async () => {
      try {
        const height = await getCurrentBlockHeight()
        if (mounted) setCurrentBlock(height)
      } catch (err) {
        devWarn('Failed to fetch block height:', err)
      }
    }

    fetchBlock()
    const interval = setInterval(fetchBlock, 15_000) // Refresh every ~1 block

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  // Calculate countdown
  useEffect(() => {
    if (currentBlock === 0n || resolution.challenge_deadline === 0n) {
      setTimeRemaining('Loading...')
      return
    }

    const blocksRemaining = Number(resolution.challenge_deadline - currentBlock)
    if (blocksRemaining <= 0) {
      setTimeRemaining('Expired')
      return
    }

    const secondsRemaining = blocksRemaining // deadlines are timestamps (seconds)
    const hours = Math.floor(secondsRemaining / 3600)
    const minutes = Math.floor((secondsRemaining % 3600) / 60)

    if (hours > 0) {
      setTimeRemaining(`${hours}h ${minutes}m`)
    } else {
      setTimeRemaining(`${minutes}m`)
    }
  }, [currentBlock, resolution.challenge_deadline])

  const isChallengeWindowOpen = useMemo(() => {
    if (currentBlock === 0n) return false
    return currentBlock < resolution.challenge_deadline && !resolution.finalized
  }, [currentBlock, resolution.challenge_deadline, resolution.finalized])

  // Available outcomes to dispute (exclude current winning outcome)
  const disputeOutcomes = useMemo(() => {
    const outcomes: number[] = []
    for (let i = 1; i <= numOutcomes; i++) {
      if (i !== resolution.winning_outcome) {
        outcomes.push(i)
      }
    }
    return outcomes
  }, [numOutcomes, resolution.winning_outcome])

  const outcomeLabels: Record<number, string> = {}
  for (let i = 1; i <= numOutcomes; i++) {
    outcomeLabels[i] = market.outcomeLabels?.[i - 1] || `Outcome ${i}`
  }

  const handleDispute = async () => {
    if (proposedOutcome === null) return

    setIsSubmitting(true)
    setError(null)

    try {
      await ensureSepoliaNetwork()

      // Dispute bond = 3x total bonded (from contract). Use a reasonable default.
      // The contract will revert if insufficient.
      const disputeBondWei = ethers.parseEther('0.003') // 3x min bond

      const receipt = await contractDispute(market.id, proposedOutcome, disputeBondWei)
      setTransactionId(receipt.hash)
    } catch (err: unknown) {
      console.error('Failed to file dispute:', err)
      setError(err instanceof Error ? parseContractError(err) : 'Failed to file dispute')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Dispute already finalized or window closed
  if (resolution.finalized) {
    return (
      <div className="glass-card p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-yes-500/10 flex items-center justify-center">
            <Check className="w-5 h-5 text-yes-400" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Resolution Finalized</h3>
            <p className="text-sm text-surface-400">
              Winning outcome: {outcomeLabels[resolution.winning_outcome] || `Outcome ${resolution.winning_outcome}`}
            </p>
          </div>
        </div>
        <p className="text-sm text-surface-400">
          The challenge window has closed and the resolution is finalized.
          No further disputes can be filed.
        </p>
      </div>
    )
  }

  return (
    <div className="glass-card overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-white/[0.04]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center">
            <ShieldAlert className="w-5 h-5 text-brand-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-white">Challenge Resolution</h3>
            <p className="text-sm text-surface-400">
              Current ruling: {outcomeLabels[resolution.winning_outcome] || `Outcome ${resolution.winning_outcome}`}
            </p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Challenge Window Countdown */}
        <div className="p-4 rounded-xl bg-brand-500/5 border border-brand-500/20">
          <div className="flex items-center gap-3">
            <Clock className="w-5 h-5 text-brand-400 flex-shrink-0" />
            <div className="flex-1">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-brand-300">Challenge Window</span>
                <span className={cn(
                  'text-sm font-bold',
                  isChallengeWindowOpen ? 'text-brand-400' : 'text-no-400'
                )}>
                  {timeRemaining}
                </span>
              </div>
              <p className="text-xs text-surface-400 mt-1">
                ~{(Number(CHALLENGE_WINDOW_BLOCKS) / 3600).toFixed(1)} hours from resolution.
                Block {resolution.challenge_deadline.toString()}.
              </p>
            </div>
          </div>
        </div>

        {transactionId ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center"
          >
            <div className="w-16 h-16 rounded-full bg-brand-500/20 mx-auto mb-4 flex items-center justify-center">
              <ShieldAlert className="w-8 h-8 text-brand-400" />
            </div>
            <h4 className="text-lg font-semibold text-white mb-2">Dispute Filed</h4>
            <p className="text-sm text-surface-400 mb-4">
              Your dispute has been submitted to the network. The bond of{' '}
              {formatCredits(MIN_DISPUTE_BOND)} ETH has been locked.
            </p>
            <TransactionLink
              transactionId={transactionId}
              showCopy={true}
              showNote={true}
            />
          </motion.div>
        ) : (
          <>
            {!isChallengeWindowOpen ? (
              <div className="p-4 rounded-xl bg-white/[0.02] text-center">
                <p className="text-surface-400">
                  The challenge window is closed. Disputes can no longer be filed.
                </p>
              </div>
            ) : (
              <>
                {/* Proposed Outcome Selector */}
                <div>
                  <label className="block text-sm font-medium text-white mb-2">
                    Proposed Correct Outcome
                  </label>
                  <p className="text-xs text-surface-400 mb-3">
                    Select the outcome you believe is correct (different from the current ruling).
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {disputeOutcomes.map((outcome) => (
                      <button
                        key={outcome}
                        onClick={() => setProposedOutcome(outcome)}
                        className={cn(
                          'p-4 rounded-xl border-2 transition-all text-center',
                          proposedOutcome === outcome
                            ? 'border-brand-500 bg-brand-500/10'
                            : 'border-surface-700 hover:border-brand-500/50'
                        )}
                      >
                        <span className="text-lg font-semibold text-white block">
                          {outcomeLabels[outcome] || `Outcome ${outcome}`}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Bond Requirement */}
                <div className="p-4 rounded-xl bg-white/[0.02]">
                  <div className="flex justify-between items-center">
                    <span className="text-surface-400 text-sm">Dispute Bond Required</span>
                    <span className="text-white font-semibold">
                      {formatCredits(MIN_DISPUTE_BOND)} ETH
                    </span>
                  </div>
                  <p className="text-xs text-surface-500 mt-2">
                    The bond is returned if your dispute is successful. If the original
                    resolution stands, the bond is forfeit.
                  </p>
                </div>

                {/* Warning */}
                <div className="flex items-start gap-3 p-4 rounded-xl bg-brand-500/5 border border-brand-500/20">
                  <AlertTriangle className="w-5 h-5 text-brand-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-brand-300">Important</p>
                    <p className="text-xs text-surface-400 mt-1">
                      Filing a dispute triggers a review process. Your{' '}
                      {formatCredits(MIN_DISPUTE_BOND)} ETH bond will be locked.
                      Only file a dispute if you believe the resolution is incorrect.
                    </p>
                  </div>
                </div>

                {/* Error Display */}
                {error && (
                  <div className="flex items-start gap-3 p-4 rounded-xl bg-no-500/10 border border-no-500/20">
                    <AlertTriangle className="w-5 h-5 text-no-400 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-no-400">{error}</p>
                  </div>
                )}

                {/* Submit */}
                <button
                  onClick={handleDispute}
                  disabled={proposedOutcome === null || isSubmitting}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 btn-primary',
                    proposedOutcome === null && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Confirm in Wallet...</span>
                    </>
                  ) : (
                    <>
                      <ShieldAlert className="w-5 h-5" />
                      <span>File Dispute ({formatCredits(MIN_DISPUTE_BOND)} ETH bond)</span>
                    </>
                  )}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
