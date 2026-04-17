import { motion, AnimatePresence } from 'framer-motion'
import {
  X,
  Trophy,
  Shield,
  Check,
  RefreshCcw,
  AlertTriangle,
  Loader2,
  Wallet,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { type Bet, useBetsStore, useWalletStore, outcomeToIndex } from '@/lib/store'
import { cn, formatCredits, getTokenSymbol } from '@/lib/utils'
import { redeemShares as contractRedeem, claimRefund as contractClaimRefund, parseContractError, ensureSepoliaNetwork, getPublicShareBalance, requestUnshieldShares, executeUnshield } from '@/lib/contracts'
import { TransactionLink } from './TransactionLink'
import { usePrivy } from '@privy-io/react-auth'

// Removed Aleo record local stubs

interface ClaimWinningsModalProps {
  mode: 'winnings' | 'refund'
  isOpen: boolean
  onClose: () => void
  bets: Bet[]
  market?: { outcomeLabels?: string[] }
  onClaimSuccess?: () => void
}

// Removed Aleo record inspection local stubs

export function ClaimWinningsModal({
  mode,
  isOpen,
  onClose,
  bets,
  market,
  onClaimSuccess
}: ClaimWinningsModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [txId, setTxId] = useState<string | null>(null)
  const [txPhase, setTxPhase] = useState<'idle' | 'pending' | 'confirmed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const { markBetClaimed } = useBetsStore()
  // Contract calls via contracts.ts

  const { wallet } = useWalletStore()
  const { user } = usePrivy()

  const [isUnshielding, setIsUnshielding] = useState(false)
  const [publicShares, setPublicShares] = useState(0n)

  const isRefund = mode === 'refund'
  const bet = bets[0] // We handle one bet at a time
  const expectedOutcome = bet ? outcomeToIndex(bet.outcome) : null

  // Fetch encrypted/unshielded balance mapping when modal opens
  useEffect(() => {
    const addr = user?.wallet?.address
    if (isOpen && bet && addr) {
      getPublicShareBalance(bet.marketId, addr, expectedOutcome || 1).then(setPublicShares).catch(() => setPublicShares(0n))
    }
    if (!isOpen) {
      setPublicShares(0n)
      setIsUnshielding(false)
    }
  }, [isOpen, bet, user?.wallet?.address, expectedOutcome])

  const handleClose = () => {
    setError(null)
    setTxId(null)
    setTxPhase('idle')
    onClose()
  }



  // Execute claim/redeem via wallet
  const handleWalletClaim = async () => {
    if (!bet || !wallet.connected) return

    setIsSubmitting(true)
    setError(null)
    try {
      if (!wallet.isDemoMode && wallet.balance.public < 500_000_000_000_000n) {
        throw new Error(
          `Insufficient ETH for gas.`
        )
      }

      await ensureSepoliaNetwork()

      const sharesToClaim = bet.sharesReceived || bet.amount || 0n
      const outcomeIndex = expectedOutcome || 1

      if (publicShares < sharesToClaim) {
        setIsUnshielding(true)
        const needToUnshield = sharesToClaim - publicShares
        const { reqId } = await requestUnshieldShares(bet.marketId, outcomeIndex, needToUnshield)
        await executeUnshield(reqId)
        setIsUnshielding(false)
      }

      let receipt
      if (isRefund) {
        receipt = await contractClaimRefund(bet.marketId, outcomeIndex, sharesToClaim)
      } else {
        receipt = await contractRedeem(bet.marketId, sharesToClaim)
      }

      setTxId(receipt.hash)
      setTxPhase('confirmed')
      markBetClaimed(bet.id)
      onClaimSuccess?.()

      // No polling needed — tx.wait() in contracts.ts already confirmed
    } catch (err: unknown) {
      console.error(`${isRefund ? 'Claim refund' : 'Redeem shares'} failed:`, err)
      const msg = err instanceof Error ? parseContractError(err) : 'Transaction failed'
      setError(msg)
      setIsSubmitting(false)
      setIsUnshielding(false)
    }
  }

  if (!bet) return null

  const tokenSymbol = getTokenSymbol('ETH')
  const maxSharesToClaim = bet.sharesReceived || bet.amount || 0n
  const payoutDisplay = isRefund
    ? formatCredits(bet.amount)
    : formatCredits(maxSharesToClaim)

  // Resolve outcome label from market data
  const resolveOutcomeLabel = (outcomeNum: number): string => {
    const defaultLabels = ['YES', 'NO', 'OPTION C', 'OPTION D']
    return market?.outcomeLabels?.[outcomeNum - 1]?.toUpperCase() || defaultLabels[outcomeNum - 1] || `Outcome ${outcomeNum}`
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
          />

          {/* Modal */}
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="w-full max-w-lg max-h-[85vh] overflow-y-auto"
            >
              <div className="glass-card overflow-hidden">
                {/* Header */}
                <div className="relative p-6 border-b border-white/[0.04]">
                  <button
                    onClick={handleClose}
                    className="absolute right-4 top-4 p-2 rounded-lg hover:bg-surface-800 transition-colors"
                  >
                    <X className="w-5 h-5 text-surface-400" />
                  </button>

                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "w-12 h-12 rounded-xl flex items-center justify-center",
                      isRefund
                        ? "bg-brand-500/20"
                        : "bg-gradient-to-br from-brand-400/20 to-brand-500/20"
                    )}>
                      {isRefund ? (
                        <RefreshCcw className="w-6 h-6 text-brand-400" />
                      ) : (
                        <Trophy className="w-6 h-6 text-brand-400" />
                      )}
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-white">
                        {isRefund ? 'Claim Refund' : 'Redeem Winnings'}
                      </h2>
                      <p className="text-sm text-surface-400">
                        {isRefund ? 'Market was cancelled — get your tokens back' : 'Redeem your winning shares for tokens'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Content */}
                <div className="p-6 space-y-6">
                  {/* Transaction success */}
                  {txId ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="text-center space-y-4"
                    >
                      <div className={cn(
                        "w-16 h-16 rounded-full mx-auto flex items-center justify-center",
                        txPhase === 'pending'
                          ? "bg-brand-500/20"
                          : isRefund ? "bg-brand-500/20" : "bg-yes-500/20"
                      )}>
                        {txPhase === 'pending' ? (
                          <Loader2 className="w-8 h-8 animate-spin text-brand-400" />
                        ) : (
                          <Check className={cn("w-8 h-8", isRefund ? "text-brand-400" : "text-yes-400")} />
                        )}
                      </div>
                      <div>
                        <h4 className="text-lg font-semibold text-white">
                          {txPhase === 'pending'
                            ? 'Transaction Submitted'
                            : isRefund ? 'Refund Submitted' : 'Redemption Submitted'}
                        </h4>
                        <p className="text-sm text-surface-400 mt-1">
                          {txPhase === 'pending'
                            ? 'Waiting for final confirmation. Your portfolio will only be marked as claimed after the transaction is accepted.'
                            : 'Transaction confirmed. Your portfolio has been marked as claimed.'}
                        </p>
                      </div>
                      <TransactionLink
                        transactionId={txId}
                        showCopy={true}
                        showNote={true}
                      />
                      <button onClick={handleClose} className="w-full btn-secondary mt-4">
                        {txPhase === 'pending' ? 'Close' : 'Done'}
                      </button>
                    </motion.div>
                  ) : (
                    <>
                      {/* Bet Summary */}
                      <div className={cn(
                        "p-4 rounded-xl border",
                        isRefund
                          ? "bg-brand-500/5 border-brand-500/20"
                          : "bg-yes-500/5 border-yes-500/20"
                      )}>
                        <p className="text-sm text-surface-400 mb-2 truncate">
                          {bet.marketQuestion || `Market ${bet.marketId}`}
                        </p>
                        <div className="flex items-center justify-between">
                          <div>
                            {(() => {
                              const idx = outcomeToIndex(bet.outcome)
                              const colors = [
                                'bg-yes-500/20 text-yes-400',
                                'bg-no-500/20 text-no-400',
                                'bg-purple-500/20 text-purple-400',
                                'bg-brand-500/20 text-brand-400',
                              ]
                              return (
                                <span className={cn(
                                  "text-xs font-medium px-2 py-0.5 rounded-full",
                                  colors[idx - 1] || colors[0]
                                )}>
                                  {resolveOutcomeLabel(outcomeToIndex(bet.outcome))}
                                </span>
                              )
                            })()}
                            <span className="text-sm text-surface-400 ml-2">
                              Shares: {formatCredits(bet.amount)} {tokenSymbol}
                            </span>
                          </div>
                          <div className="text-right">
                            <p className={cn(
                              "text-2xl font-bold",
                              isRefund ? "text-brand-400" : "text-yes-400"
                            )}>
                              {isRefund ? '' : '+'}{payoutDisplay}
                            </p>
                            <p className="text-xs text-surface-500">{tokenSymbol}</p>
                          </div>
                        </div>
                      </div>

                      {/* Removed Aleo Record Selection Area */}

                      {/* Error display */}
                      {error && (
                        <div className="flex items-start gap-3 p-4 rounded-xl bg-no-500/10 border border-no-500/20">
                          <AlertTriangle className="w-5 h-5 text-no-400 flex-shrink-0 mt-0.5" />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-no-400">Transaction Failed</p>
                            <p className="text-xs text-surface-400 mt-1">{error}</p>
                          </div>
                        </div>
                      )}

                      {/* Wallet Claim Button */}
                      {wallet.connected && (
                        <div className="space-y-3">
                          <button
                            onClick={handleWalletClaim}
                            disabled={isSubmitting || isUnshielding}
                            className={cn(
                              "w-full py-3 rounded-xl font-medium transition-all flex items-center justify-center gap-2",
                              isRefund
                                ? "bg-brand-500 hover:bg-brand-400 text-white"
                                : "bg-gradient-to-r from-yes-500 to-brand-500 hover:from-yes-400 hover:to-brand-400 text-white",
                              (isSubmitting || isUnshielding) && "opacity-70 cursor-not-allowed"
                            )}
                          >
                            {isSubmitting || isUnshielding ? (
                              <>
                                <Loader2 className="w-5 h-5 animate-spin" />
                                <span>{isUnshielding ? 'Unshielding Shares...' : 'Confirm in Wallet...'}</span>
                              </>
                            ) : (
                              <>
                                <Wallet className="w-5 h-5" />
                                <span>{isRefund ? (publicShares < maxSharesToClaim ? 'Unshield & Claim Refund' : 'Claim Refund') : (publicShares < maxSharesToClaim ? 'Unshield & Redeem' : 'Redeem')}</span>
                              </>
                            )}
                          </button>
                        </div>
                      )}

                      {/* Privacy Notice */}
                      <div className="flex items-start gap-3 p-4 rounded-xl bg-brand-500/5 border border-brand-500/20">
                        <Shield className="w-5 h-5 text-brand-400 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="text-sm font-medium text-brand-300">Privacy Preserved</p>
                          <p className="text-xs text-surface-400 mt-1">
                            {isRefund
                              ? 'Your refund will be transferred privately. No one can see your position.'
                              : 'Your winnings are transferred privately via ZK proof. Your payout amount is hidden from observers.'}
                          </p>
                        </div>
                      </div>


                      {/* Close button */}
                      <button onClick={handleClose} className="w-full btn-secondary">
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  )
}
