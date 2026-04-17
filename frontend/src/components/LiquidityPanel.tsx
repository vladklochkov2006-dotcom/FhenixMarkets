import { motion } from 'framer-motion'
import { Droplets, Plus, Minus, Loader2, AlertCircle, Check, Info } from 'lucide-react'
import { useState, useMemo } from 'react'
import { type Market, useWalletStore } from '@/lib/store'
import { cn, formatCredits } from '@/lib/utils'
import {
  addLiquidity as contractAddLiquidity,
  withdrawLiquidity as contractWithdrawLiquidity,
  claimLPRefund as contractClaimLPRefund,
  parseEth,
  parseContractError,
  ensureSepoliaNetwork,
  MARKET_STATUS,
  getPublicLPBalance,
  requestUnshieldLP,
  executeUnshield
} from '@/lib/contracts'
import { calculateLPSharesOut } from '@/lib/amm'
import { TransactionLink } from './TransactionLink'
import { usePrivy } from '@privy-io/react-auth'
import { useEffect } from 'react'

interface LiquidityPanelProps {
  market: Market
}

type LiquidityTab = 'add' | 'withdraw'

export function LiquidityPanel({ market }: LiquidityPanelProps) {
  const { wallet } = useWalletStore()
  // Contract calls via contracts.ts

  const isResolved = market.status === MARKET_STATUS.RESOLVED
  const isCancelled = market.status === MARKET_STATUS.CANCELLED
  const isMarketEnded = market.status !== MARKET_STATUS.OPEN
  const isCreator = wallet.address && market.creator && wallet.address === market.creator

  const [activeTab, setActiveTab] = useState<LiquidityTab>(
    isResolved || isCancelled ? 'withdraw' : 'add'
  )
  const [amount, setAmount] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [transactionId, setTransactionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // LP share amount for withdraw (user enters amount in ETH)
  const [lpSharesInput, setLpSharesInput] = useState('')
  const [isUnshielding, setIsUnshielding] = useState(false)
  const [publicLPShares, setPublicLPShares] = useState(0n)

  const { user } = usePrivy()
  const tokenSymbol = 'ETH'

  // v20: Use total reserves (sum of AMM reserves) for LP calculations
  const totalReserves = (market.yesReserve ?? 0n) + (market.noReserve ?? 0n)
    + (market.reserve3 ?? 0n) + (market.reserve4 ?? 0n)
  const totalLiquidity = market.totalLiquidity ?? totalReserves
  const totalLPShares = market.totalLPShares ?? totalReserves

  // For resolved/cancelled markets, show actual remaining collateral (after winner claims)
  const displayLiquidity = (isResolved || isCancelled) && market.remainingCredits !== undefined
    ? market.remainingCredits
    : totalLiquidity

  const amountWei = amount
    ? parseEth(amount)
    : 0n

  // On Ethereum, winner claim window is not block-based; disable the concept
  const winnerClaimWindowActive = false
  const winnerClaimTimeRemaining: string | null = null

  // Calculate LP shares for adding
  const lpSharesOut = useMemo(() => {
    if (amountWei <= 0n) return 0n
    return calculateLPSharesOut(amountWei, totalLPShares, totalReserves)
  }, [amountWei, totalLPShares, totalReserves])

  useEffect(() => {
    const addr = user?.wallet?.address
    if (addr && market.id) {
      getPublicLPBalance(market.id, addr).then(setPublicLPShares).catch(() => setPublicLPShares(0n))
    }
  }, [user?.wallet?.address, market.id])

  const handleAddLiquidity = async () => {
    if (!amount || amountWei <= 0n) return

    setIsSubmitting(true)
    setError(null)

    try {
      await ensureSepoliaNetwork()
      const receipt = await contractAddLiquidity(market.id, amountWei)
      setTransactionId(receipt.hash)
    } catch (err: unknown) {
      console.error('Failed to add liquidity:', err)
      setError(parseContractError(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleWithdrawLpResolved = async () => {
    const lpSharesWei = lpSharesInput ? parseEth(lpSharesInput) : 0n
    if (lpSharesWei <= 0n) return

    setIsSubmitting(true)
    setError(null)

    try {
      await ensureSepoliaNetwork()

      if (publicLPShares < lpSharesWei) {
        setIsUnshielding(true)
        const needToUnshield = lpSharesWei - publicLPShares
        const { reqId } = await requestUnshieldLP(market.id, needToUnshield)
        await executeUnshield(reqId)
        setIsUnshielding(false)
      }

      const receipt = isCancelled
        ? await contractClaimLPRefund(market.id, lpSharesWei)
        : await contractWithdrawLiquidity(market.id, lpSharesWei)
      setTransactionId(receipt.hash)
    } catch (err: unknown) {
      console.error('Failed to withdraw LP:', err)
      setError(parseContractError(err))
      setIsUnshielding(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  const resetState = () => {
    setAmount('')
    setLpSharesInput('')
    setTransactionId(null)
    setError(null)
  }

  const handleTabChange = (tab: LiquidityTab) => {
    setActiveTab(tab)
    resetState()
  }

  return (
    <div className="glass-card overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-white/[0.04]">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-accent-500/10 flex items-center justify-center">
            <Droplets className="w-5 h-5 text-accent-400" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Liquidity</h3>
            <p className="text-sm text-surface-400">
              {(isResolved || isCancelled) ? 'Remaining' : 'Pool'}: {formatCredits(displayLiquidity)} {tokenSymbol}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex bg-white/[0.03] rounded-xl p-1">
          {(isResolved || isCancelled) ? (
            <button
              onClick={() => handleTabChange('withdraw')}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium bg-brand-500/20 text-brand-400"
            >
              <Minus className="w-4 h-4" />
              {isCancelled
                ? 'Claim LP Refund'
                : winnerClaimWindowActive
                  ? 'Winner Claim Window'
                  : 'Withdraw LP'}
            </button>
          ) : (
            <button
              onClick={() => handleTabChange('add')}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium bg-brand-500/20 text-brand-400"
            >
              <Plus className="w-4 h-4" />
              Add Liquidity
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        {transactionId ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center"
          >
            <div className="w-16 h-16 rounded-full bg-yes-500/20 mx-auto mb-4 flex items-center justify-center">
              <Check className="w-8 h-8 text-yes-400" />
            </div>
            <h4 className="text-lg font-semibold text-white mb-2">
              {activeTab === 'add' ? 'Liquidity Added' : 'LP Withdrawn'}
            </h4>
            <TransactionLink
              transactionId={transactionId}
              className="mb-4"
              showCopy={true}
              showNote={false}
            />
            <button
              onClick={resetState}
              className="btn-secondary w-full mt-4"
            >
              New Transaction
            </button>
          </motion.div>
        ) : (
          <>
            {activeTab === 'withdraw' ? (
              <div className="space-y-4">
                {winnerClaimWindowActive ? (
                  <div className="p-4 rounded-xl bg-brand-500/10 border border-brand-500/20 mb-2">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-5 h-5 text-brand-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-brand-300">Winner claim window is active</p>
                        <p className="text-xs text-yellow-200/80 mt-1 leading-relaxed">
                          Winning traders must be able to redeem before LP collateral can leave the market.
                          {winnerClaimTimeRemaining
                            ? ` LP withdrawals unlock in about ${winnerClaimTimeRemaining}.`
                            : ' LP withdrawals will unlock after the current block height is verified and the priority window ends.'}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 rounded-xl bg-brand-500/10 border border-brand-500/20 mb-2">
                    <div className="flex items-center gap-2">
                      <Droplets className="w-5 h-5 text-brand-400 flex-shrink-0" />
                      <p className="text-sm text-brand-400">
                        {isCancelled
                          ? 'This market was cancelled. Claim your LP tokens back.'
                          : 'This market has been resolved. Withdraw your LP share.'}
                      </p>
                    </div>
                  </div>
                )}

                {/* LP Shares Amount Input */}
                <div>
                  <label className="block text-sm text-surface-400 mb-2">
                    LP Shares to Withdraw
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      value={lpSharesInput}
                      onChange={(e) => setLpSharesInput(e.target.value)}
                      placeholder="0.00"
                      className="input-field text-xl font-semibold pr-20"
                    />
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-surface-400 text-sm">
                      LP shares
                    </div>
                  </div>
                </div>

                {/* Non-creator notice */}
                {!isCreator && wallet.connected && (
                  <div className="flex items-start gap-2.5 p-3 rounded-lg bg-brand-500/10 border border-brand-500/20">
                    <Info className="w-4 h-4 text-brand-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-brand-300/90 leading-relaxed">
                      Your wallet is not the creator of this market. You can only withdraw LP if you previously added liquidity.
                    </p>
                  </div>
                )}

                <button
                  onClick={handleWithdrawLpResolved}
                  disabled={!lpSharesInput || parseFloat(lpSharesInput) <= 0 || isSubmitting || isUnshielding}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 btn-primary',
                    (!lpSharesInput || parseFloat(lpSharesInput) <= 0) && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {isSubmitting || isUnshielding ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>{isUnshielding ? 'Unshielding LP Shares...' : 'Confirm in Wallet...'}</span>
                    </>
                  ) : (
                    <>
                      <Minus className="w-5 h-5" />
                      <span>
                        {isCancelled
                          ? (publicLPShares < (lpSharesInput ? parseEth(lpSharesInput) : 0n) ? 'Unshield & Claim LP Refund' : 'Claim LP Refund')
                          : winnerClaimWindowActive
                            ? 'Winner Claim Window Active'
                            : (publicLPShares < (lpSharesInput ? parseEth(lpSharesInput) : 0n) ? 'Unshield & Withdraw LP' : 'Withdraw LP')}
                      </span>
                    </>
                  )}
                </button>
              </div>
            ) : (
              /* ---- ADD TAB ---- */
              <div className="space-y-4">
                {/* Amount Input */}
                <div>
                  <label className="block text-sm text-surface-400 mb-2">
                    Amount ({tokenSymbol})
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      className="input-field text-xl font-semibold pr-20"
                    />
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-surface-400 text-sm">
                      {tokenSymbol}
                    </div>
                  </div>
                  <div className="flex justify-between text-sm mt-2">
                    <span className="text-surface-500">
                      Balance: {formatCredits(wallet.balance.public)} {tokenSymbol}
                    </span>
                    <button
                      onClick={() => {
                        const bal = wallet.balance.public
                        // Reserve some ETH for gas
                        const gasReserve = parseEth('0.01')
                        const usable = bal > gasReserve ? bal - gasReserve : 0n
                        setAmount((Number(usable) / 1e18).toString())
                      }}
                      className="text-brand-400 hover:text-brand-300"
                    >
                      Max
                    </button>
                  </div>
                </div>

                {/* LP Shares Preview */}
                {amountWei > 0n && (
                  <div className="p-4 rounded-xl bg-white/[0.03]">
                    <div className="flex justify-between items-center">
                      <span className="text-surface-400 text-sm">LP Shares You Receive</span>
                      <span className="text-white font-semibold">
                        {formatCredits(lpSharesOut)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-2">
                      <span className="text-surface-400 text-sm">Share of Pool</span>
                      <span className="text-surface-300 text-sm">
                        {totalLiquidity > 0n
                          ? ((Number(amountWei) / Number(totalLiquidity + amountWei)) * 100).toFixed(2)
                          : '100.00'
                        }%
                      </span>
                    </div>
                  </div>
                )}

                {/* Info */}
                <div className="p-3 rounded-lg bg-brand-500/5 border border-brand-500/20">
                  <p className="text-xs text-surface-400">
                    Adding liquidity earns you 1% of all trades in this market, proportional to your share.
                    Liquidity is split evenly across all outcomes.
                  </p>
                </div>

                <button
                  onClick={handleAddLiquidity}
                  disabled={!amount || parseFloat(amount) <= 0 || isSubmitting || !!isMarketEnded}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 btn-primary',
                    (!amount || parseFloat(amount) <= 0 || !!isMarketEnded) && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Confirm in Wallet...</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-5 h-5" />
                      <span>Add Liquidity</span>
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Error Display */}
            {error && (
              <div className="flex items-start gap-3 p-4 rounded-xl bg-no-500/10 border border-no-500/20 mt-4">
                <AlertCircle className="w-5 h-5 text-no-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-no-400">{error}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

