import { motion, AnimatePresence } from 'framer-motion'
import { X, Shield, ShieldAlert, TrendingUp, Check, Loader2, AlertCircle, Settings2 } from 'lucide-react'
import { useState, useMemo } from 'react'
import { type Market, useWalletStore, useBetsStore, outcomeToString } from '@/lib/store'
import { cn, formatCredits, getCategoryName, getCategoryEmoji } from '@/lib/utils'
import { TransactionLink } from './TransactionLink'
import { calculateBuySharesOut, calculateBuyPriceImpact, calculateMinSharesOut, calculateFees, type AMMReserves } from '@/lib/amm'
import { devWarn } from '../lib/logger'
import { buyShares as contractBuyShares, fetchMarket, parseEth, parseContractError, ensureSepoliaNetwork, MARKET_STATUS } from '@/lib/contracts'
// ethers removed — not directly needed here

interface BuySharesModalProps {
  market: Market | null
  isOpen: boolean
  onClose: () => void
}

type BuyStep = 'select' | 'amount' | 'success'

const OUTCOME_COLORS = ['yes', 'no', 'brand', 'yellow'] as const
const OUTCOME_LABELS_DEFAULT = ['Yes', 'No', 'Option C', 'Option D']

function getOutcomeColor(outcome: number): string {
  return OUTCOME_COLORS[Math.min(outcome - 1, 3)] || 'brand'
}

export function BuySharesModal({ market, isOpen, onClose }: BuySharesModalProps) {
  const { wallet } = useWalletStore()
  const { addPendingBet, confirmPendingBet } = useBetsStore()
  // Contract transaction — no legacy adapter needed

  const [selectedOutcome, setSelectedOutcome] = useState<number | null>(null)
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<BuyStep>('select')
  const [isPlacing, setIsPlacing] = useState(false)
  const [transactionId, setTransactionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [privacyMode, setPrivacyMode] = useState<'private' | 'public' | null>(null)
  const [slippageTolerance, setSlippageTolerance] = useState(2) // 2% default
  const [showSlippageSettings, setShowSlippageSettings] = useState(false)
  const [isSlowTransaction, setIsSlowTransaction] = useState(false)

  const numOutcomes = market?.numOutcomes || 2
  const outcomeLabels = market?.outcomeLabels || OUTCOME_LABELS_DEFAULT.slice(0, numOutcomes)
  const tokenSymbol = 'ETH'
  const isExpired = market ? (market.timeRemaining === 'Ended' || market.status !== 1) : false

  // AMM reserves from market data
  const ammReserves: AMMReserves | null = useMemo(() => {
    if (!market) return null
    return {
      reserve_1: market.yesReserve || 0n,
      reserve_2: market.noReserve || 0n,
      reserve_3: market.reserve3 || 0n,
      reserve_4: market.reserve4 || 0n,
      num_outcomes: numOutcomes,
    }
  }, [market, numOutcomes])

  // Calculate shares out and price impact
  const tradePreview = useMemo(() => {
    if (!selectedOutcome || !amount || !ammReserves) return null
    const amountWei = parseEth(amount)
    if (amountWei <= 0n) return null

    const sharesOut = calculateBuySharesOut(ammReserves, selectedOutcome, amountWei)
    const minShares = calculateMinSharesOut(sharesOut, slippageTolerance)
    const priceImpact = calculateBuyPriceImpact(ammReserves, selectedOutcome, amountWei)
    const fees = calculateFees(amountWei)

    return {
      sharesOut,
      minShares,
      priceImpact,
      fees,
      // Winning shares redeem 1:1 (use minShares — matches on-chain record quantity)
      potentialPayout: Number(minShares) / 1e18,
    }
  }, [selectedOutcome, amount, ammReserves, slippageTolerance])

  // Get outcome prices
  const outcomePrices = useMemo(() => {
    if (!market) return []
    const prices: number[] = []
    const total = (market.yesReserve || 0n) + (market.noReserve || 0n) + (market.reserve3 || 0n) + (market.reserve4 || 0n)
    if (total === 0n) return Array(numOutcomes).fill(1 / numOutcomes)

    const reserves = [market.yesReserve || 0n, market.noReserve || 0n, market.reserve3 || 0n, market.reserve4 || 0n]
    for (let i = 0; i < numOutcomes; i++) {
      prices.push(Number(reserves[i]) / Number(total))
    }
    return prices
  }, [market, numOutcomes])

  const handleBuyShares = async () => {
    if (!market || !selectedOutcome || !amount) return

    setIsPlacing(true)
    setError(null)

    try {
      // Check if this is a real on-chain market (bytes32 hex ID)
      if (!market.id.startsWith('0x')) {
        throw new Error('This is a demo market. Use markets created via "Create Market" to trade on-chain.')
      }

      const amountWei = parseEth(amount)
      const minSharesOut = tradePreview?.minShares || 0n

      // Pre-validate market status on-chain
      try {
        const onChainMarket = await fetchMarket(market.id)
        if (onChainMarket && onChainMarket.status !== MARKET_STATUS.OPEN) {
          throw new Error('Market is not open for trading.')
        }
        const now = BigInt(Math.floor(Date.now() / 1000))
        if (onChainMarket && now > onChainMarket.deadline) {
          throw new Error('Betting deadline has passed. Trading is no longer available.')
        }
      } catch (validationErr) {
        if (validationErr instanceof Error &&
            (validationErr.message.includes('not open') || validationErr.message.includes('deadline'))) {
          throw validationErr
        }
        devWarn('Pre-validation skipped (network error):', validationErr)
      }

      // Ensure wallet is on Sepolia
      await ensureSepoliaNetwork()
      setPrivacyMode('private') // All shares are FHE-encrypted

      // Show slow transaction indicator after 30s
      setIsSlowTransaction(false)
      const slowTimer = setTimeout(() => setIsSlowTransaction(true), 30_000)

      try {
        // Call buyShares on-chain (triggers wallet popup, waits for receipt)
        const receipt = await contractBuyShares(
          market.id,
          selectedOutcome!,
          minSharesOut,
          amountWei,
        )

        clearTimeout(slowTimer)
        setIsSlowTransaction(false)

        const txHash = receipt.hash
        setTransactionId(txHash)
        setStep('success')

        // Track bet locally
        addPendingBet({
          id: txHash,
          marketId: market.id,
          amount: amountWei,
          outcome: outcomeToString(selectedOutcome),
          placedAt: Date.now(),
          status: 'pending',
          marketQuestion: market.question,
          lockedMultiplier: tradePreview?.potentialPayout ? tradePreview.potentialPayout / parseFloat(amount) : 1,
          sharesReceived: minSharesOut,
          tokenType: 'ETH',
        })

        // Tx already confirmed (receipt returned), mark as confirmed
        confirmPendingBet(txHash, txHash)

        // Refresh balance
        setTimeout(() => useWalletStore.getState().refreshBalance(), 3000)
      } finally {
        clearTimeout(slowTimer)
        setIsSlowTransaction(false)
      }
    } catch (err: unknown) {
      console.error('Failed to buy shares:', err)
      const msg = err instanceof Error ? parseContractError(err) : 'An unknown error occurred.'
      setError(msg)
    } finally {
      setIsPlacing(false)
    }
  }

  const handleClose = () => {
    setSelectedOutcome(null)
    setAmount('')
    setStep('select')
    setTransactionId(null)
    setError(null)
    setPrivacyMode(null)
    setShowSlippageSettings(false)
    onClose()
  }

  if (!market) return null

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed inset-x-4 top-[10%] md:inset-auto md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-full md:max-w-lg z-50"
          >
            <div className="glass-card overflow-hidden max-h-[80vh] overflow-y-auto">
              {/* Header */}
              <div className="relative p-6 border-b border-white/[0.04]">
                <button onClick={handleClose} className="absolute right-4 top-4 p-2 rounded-lg hover:bg-surface-800 transition-colors">
                  <X className="w-5 h-5 text-surface-400" />
                </button>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">{getCategoryEmoji(market.category)}</span>
                  <span className="category-badge">{getCategoryName(market.category)}</span>
                  {privacyMode && (
                    <div className={cn('privacy-indicator ml-auto', privacyMode === 'public' && 'opacity-60')}>
                      {privacyMode === 'public' ? <ShieldAlert className="w-3 h-3" /> : <Shield className="w-3 h-3" />}
                      <span>{privacyMode === 'public' ? 'Public' : 'Private'}</span>
                    </div>
                  )}
                </div>
                <h2 className="text-xl font-semibold text-white pr-8">{market.question}</h2>
              </div>

              <div className="p-6">
                <AnimatePresence mode="wait">
                  {step === 'select' && (
                    <motion.div key="select" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                      {isExpired && (
                        <div className="p-4 rounded-xl bg-no-500/10 border border-no-500/20 mb-4">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="w-5 h-5 text-no-400 flex-shrink-0" />
                            <p className="text-sm text-no-400 font-medium">Market has expired. Trading is no longer available.</p>
                          </div>
                        </div>
                      )}

                      <p className="text-surface-400 text-sm mb-4">Select an outcome to buy shares</p>

                      {/* Multi-outcome selector */}
                      <div className={cn(
                        'grid gap-3 mb-6',
                        numOutcomes <= 2 ? 'grid-cols-2' : numOutcomes === 3 ? 'grid-cols-3' : 'grid-cols-2'
                      )}>
                        {Array.from({ length: numOutcomes }, (_, i) => i + 1).map((outcome) => {
                          const color = getOutcomeColor(outcome)
                          const price = outcomePrices[outcome - 1] || 0
                          const isSelected = selectedOutcome === outcome

                          return (
                            <button
                              key={outcome}
                              onClick={() => setSelectedOutcome(outcome)}
                              className={cn(
                                'relative p-4 rounded-xl border-2 transition-all duration-200',
                                isSelected
                                  ? `border-${color}-500 bg-${color}-500/10`
                                  : `border-surface-700 hover:border-${color}-500/50 hover:bg-${color}-500/5`
                              )}
                              style={isSelected ? {
                                borderColor: color === 'yes' ? '#22c55e' : color === 'no' ? '#ef4444' : color === 'brand' ? '#9171f8' : '#eab308',
                                backgroundColor: color === 'yes' ? 'rgba(34,197,94,0.1)' : color === 'no' ? 'rgba(239,68,68,0.1)' : color === 'brand' ? 'rgba(139,92,246,0.1)' : 'rgba(234,179,8,0.1)',
                              } : {}}
                            >
                              {isSelected && (
                                <div className="absolute top-2 right-2">
                                  <Check className="w-4 h-4" style={{
                                    color: color === 'yes' ? '#4ade80' : color === 'no' ? '#f87171' : color === 'brand' ? '#a78bfa' : '#0AD9DC'
                                  }} />
                                </div>
                              )}
                              <div className="text-2xl font-bold mb-1" style={{
                                color: color === 'yes' ? '#4ade80' : color === 'no' ? '#f87171' : color === 'brand' ? '#a78bfa' : '#0AD9DC'
                              }}>
                                {(price * 100).toFixed(1)}%
                              </div>
                              <div className="text-sm font-semibold text-white">{outcomeLabels[outcome - 1]}</div>
                              <div className="text-xs text-surface-400 mt-1">
                                ${price.toFixed(3)}/share
                              </div>
                            </button>
                          )
                        })}
                      </div>

                      {/* Amount input (combined step) */}
                      {selectedOutcome && !isExpired && (
                        <>
                          <div className="mb-4">
                            <div className="flex items-center justify-between mb-2">
                              <label className="text-sm text-surface-400">Amount ({tokenSymbol})</label>
                              <button
                                onClick={() => setShowSlippageSettings(!showSlippageSettings)}
                                className="flex items-center gap-1 text-xs text-surface-400 hover:text-white transition-colors"
                              >
                                <Settings2 className="w-3 h-3" />
                                Slippage: {slippageTolerance}%
                              </button>
                            </div>

                            {showSlippageSettings && (
                              <div className="flex gap-2 mb-3">
                                {[0.5, 1, 2, 5].map((s) => (
                                  <button
                                    key={s}
                                    onClick={() => setSlippageTolerance(s)}
                                    className={cn(
                                      'px-3 py-1 rounded-lg text-xs font-medium transition-colors',
                                      slippageTolerance === s
                                        ? 'bg-brand-500/20 text-brand-300 border border-brand-500/30'
                                        : 'bg-surface-800 text-surface-400 hover:text-white'
                                    )}
                                  >
                                    {s}%
                                  </button>
                                ))}
                              </div>
                            )}

                            <div className="relative">
                              <input
                                type="number"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                placeholder="0.00"
                                className="input-field text-xl font-semibold pr-20"
                              />
                              <div className="absolute right-4 top-1/2 -translate-y-1/2 text-surface-400">{tokenSymbol}</div>
                            </div>
                            <div className="flex justify-between text-xs mt-2">
                              <span className="text-surface-500">
                                {`Balance: ${formatCredits(wallet.balance.public + wallet.balance.private)} ETH (private: ${formatCredits(wallet.balance.private)})`}
                              </span>
                              <button
                                onClick={() => {
                                  // Use total balance (public + private) minus gas buffer
                                  const bal = wallet.balance.public + wallet.balance.private
                                  const gasReserve = 700_000_000_000_000n // ~0.0007 ETH
                                  const usable = bal > gasReserve ? bal - gasReserve : 0n
                                  setAmount((Number(usable) / 1e18).toString())
                                }}
                                className="text-brand-400 hover:text-brand-300"
                              >
                                Max
                              </button>
                            </div>
                          </div>

                          {/* Trade preview */}
                          {tradePreview && tradePreview.sharesOut > 0n && (
                            <div className="p-4 rounded-xl bg-white/[0.03] mb-4 space-y-2">
                              <div className="flex justify-between text-sm">
                                <span className="text-surface-400">Shares received</span>
                                <span className="font-medium text-white">
                                  {(Number(tradePreview.sharesOut) / 1e18).toFixed(4)}
                                </span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-surface-400">Min shares (after slippage)</span>
                                <span className="text-surface-300">
                                  {(Number(tradePreview.minShares) / 1e18).toFixed(4)}
                                </span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-surface-400">Price impact</span>
                                <span className={cn(
                                  'font-medium',
                                  Math.abs(tradePreview.priceImpact) > 5 ? 'text-no-400' :
                                  Math.abs(tradePreview.priceImpact) > 2 ? 'text-brand-400' : 'text-yes-400'
                                )}>
                                  {tradePreview.priceImpact > 0 ? '+' : ''}{tradePreview.priceImpact.toFixed(2)}%
                                </span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-surface-400">Fees (2%)</span>
                                <span className="text-surface-300">
                                  {(Number(tradePreview.fees.totalFees) / 1e18).toFixed(4)} {tokenSymbol}
                                </span>
                              </div>
                              <div className="border-t border-surface-700 pt-2 flex justify-between">
                                <span className="text-surface-400">Payout if wins</span>
                                <span className="text-lg font-bold text-white">
                                  {tradePreview.potentialPayout.toFixed(4)} {tokenSymbol}
                                </span>
                              </div>
                            </div>
                          )}

                          {/* High price impact warning */}
                          {tradePreview && Math.abs(tradePreview.priceImpact) > 5 && (
                            <div className="flex items-start gap-2 p-3 rounded-lg bg-no-500/10 border border-no-500/20 mb-4">
                              <AlertCircle className="w-4 h-4 text-no-400 mt-0.5" />
                              <p className="text-xs text-no-300">
                                High price impact! Consider reducing your trade size.
                              </p>
                            </div>
                          )}

                          {isSlowTransaction && (
                            <div className="p-3 rounded-lg bg-brand-500/10 border border-brand-500/20 mb-4">
                              <p className="text-sm text-brand-400">
                                This is taking longer than expected. Please check that your wallet extension
                                is open and unlocked. The transaction may take 30-60 seconds to process.
                              </p>
                            </div>
                          )}

                          {error && (
                            <div className="flex items-start gap-3 p-4 rounded-xl bg-no-500/10 border border-no-500/20 mb-4">
                              <AlertCircle className="w-5 h-5 text-no-400 flex-shrink-0 mt-0.5" />
                              <div>
                                <p className="text-sm font-medium text-no-400">Trade Failed</p>
                                <p className="text-sm text-surface-400 mt-1">{error}</p>
                              </div>
                            </div>
                          )}

                          <button
                            onClick={handleBuyShares}
                            disabled={!amount || parseFloat(amount) <= 0 || isPlacing}
                            className={cn(
                              'w-full flex items-center justify-center gap-2 btn-primary',
                              (!amount || parseFloat(amount) <= 0) && 'opacity-50 cursor-not-allowed'
                            )}
                          >
                            {isPlacing ? (
                              <>
                                <Loader2 className="w-5 h-5 animate-spin" />
                                <span>{isSlowTransaction ? 'Processing...' : 'Confirm in Wallet...'}</span>
                              </>
                            ) : (
                              <>
                                <TrendingUp className="w-5 h-5" />
                                <span>Buy {outcomeLabels[(selectedOutcome || 1) - 1]} Shares</span>
                              </>
                            )}
                          </button>
                        </>
                      )}

                      {!selectedOutcome && !isExpired && (
                        <p className="text-center text-surface-500 text-sm">Select an outcome above to continue</p>
                      )}
                    </motion.div>
                  )}

                  {step === 'success' && (
                    <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-6">
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', delay: 0.2 }}
                        className="w-20 h-20 rounded-full mx-auto mb-6 flex items-center justify-center bg-yes-500/20"
                      >
                        <Check className="w-10 h-10 text-yes-400" />
                      </motion.div>

                      <h3 className="text-2xl font-bold text-white mb-2">Shares Purchased!</h3>
                      <p className="text-surface-400 mb-6">Your trade has been submitted on-chain</p>

                      <div className="p-4 rounded-xl bg-white/[0.03] mb-6 text-left">
                        <div className="flex justify-between mb-2">
                          <span className="text-surface-400">Amount</span>
                          <span className="font-medium text-white">{amount} {tokenSymbol}</span>
                        </div>
                        <div className="flex justify-between mb-2">
                          <span className="text-surface-400">Outcome</span>
                          <span className="font-medium text-white">{outcomeLabels[(selectedOutcome || 1) - 1]}</span>
                        </div>
                        {tradePreview && (
                          <>
                            <div className="flex justify-between mb-2">
                              <span className="text-surface-400">Shares</span>
                              <span className="font-medium text-white">
                                {(Number(tradePreview.sharesOut) / 1e18).toFixed(4)}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-surface-400">Payout if wins</span>
                              <span className="font-medium text-white">{tradePreview.potentialPayout.toFixed(4)} {tokenSymbol}</span>
                            </div>
                          </>
                        )}
                      </div>

                      {transactionId && (
                        <TransactionLink transactionId={transactionId} className="mb-4" showCopy={true} showNote={true} />
                      )}

                      <div className="flex items-center justify-center gap-2 text-sm text-brand-400 mb-6">
                        <Shield className="w-4 h-4" />
                        <span>ZK Proof Generated {privacyMode === 'private' ? '- Fully Private' : '- Public Mode'}</span>
                      </div>

                      <button onClick={handleClose} className="btn-primary w-full">Done</button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
