import { motion, AnimatePresence } from 'framer-motion'
import { Shield, Eye, Lock, ArrowRight, Wallet, Zap, ChevronRight, BarChart3, Users, Globe, Code, Sparkles, Target, Clock, ArrowUpRight, TrendingUp, LayoutDashboard } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useWalletStore, type Market } from '@/lib/store'
import { useRealMarketsStore } from '@/lib/market-store'
import { formatCredits, formatPercentage, getCategoryName, getCategoryEmoji, getCategoryColor } from '@/lib/utils'
import { TrendingMarkets } from '@/components/TrendingMarkets'
import { useLiveCountdown } from '@/hooks/useGlobalTicker'
import { getMarketThumbnail, isContainThumbnail } from '@/lib/market-thumbnails'

// ── FHE Encryption Demo (real cofhejs API flow) ──
type DemoStage = 'idle' | 'init' | 'encrypt' | 'send' | 'confirm' | 'done'

function FHEDemo() {
  const [stage, setStage] = useState<DemoStage>('idle')
  const [choice, setChoice] = useState<'YES' | 'NO' | null>(null)
  const amount = 50
  const outcomeId = (c: string) => c === 'YES' ? 1 : 0

  const handleVote = (side: 'YES' | 'NO') => {
    if (stage !== 'idle' && stage !== 'done') return
    setChoice(side)
    setStage('init')
    setTimeout(() => setStage('encrypt'), 1200)
    setTimeout(() => setStage('send'), 3000)
    setTimeout(() => setStage('confirm'), 4500)
    setTimeout(() => setStage('done'), 5800)
  }

  const reset = () => { setStage('idle'); setChoice(null) }

  const steps: { key: DemoStage; label: string }[] = [
    { key: 'init', label: 'Initialize' },
    { key: 'encrypt', label: 'Encrypt' },
    { key: 'send', label: 'Transact' },
    { key: 'confirm', label: 'Confirm' },
  ]
  const stepKeys = steps.map(s => s.key)
  const activeIdx = stage === 'done' ? stepKeys.length : stepKeys.indexOf(stage)
  const past = (s: DemoStage) => activeIdx > stepKeys.indexOf(s)
  const active = (s: DemoStage) => stage === s
  const reached = (s: DemoStage) => activeIdx >= stepKeys.indexOf(s)

  // Terminal line helper
  const Line = ({ delay, children }: { delay: number; children: React.ReactNode }) => (
    <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay, duration: 0.25 }}>
      {children}
    </motion.div>
  )

  const Blink = ({ text }: { text: string }) => (
    <motion.span className="text-brand-400" animate={{ opacity: [1, 0.3] }}
      transition={{ duration: 0.5, repeat: Infinity, repeatType: 'reverse' }}>{text}</motion.span>
  )

  return (
    <section id="demo" className="relative py-24 z-10">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-12">
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-brand-400 mb-4">Live Demo</p>
          <h2 className="font-display text-[2.5rem] lg:text-[3rem] leading-[1.1] tracking-tight text-white">
            See FHE in{' '}<span className="gradient-text">Action</span>
          </h2>
          <p className="text-surface-400 mt-3">Click YES or NO to simulate an encrypted prediction</p>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
          className="max-w-2xl mx-auto rounded-2xl overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(8, 32, 48, 0.9) 0%, rgba(4, 20, 32, 0.95) 100%)',
            border: '1px solid rgba(10, 217, 220, 0.08)',
            boxShadow: '0 4px 40px -8px rgba(0, 0, 0, 0.5)',
          }}>

          {/* Market header */}
          <div className="px-6 pt-6 pb-4 border-b border-white/[0.04]">
            <div className="flex items-center gap-2 mb-3">
              <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold text-brand-400 bg-brand-400/10">DEMO</span>
              <span className="text-[10px] text-surface-500 uppercase tracking-wider">Simulated Market</span>
            </div>
            <p className="text-white font-display text-lg font-semibold">Will ETH surpass $5,000 by end of 2026?</p>
          </div>

          <div className="px-6 py-5">
            {/* Vote buttons */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              <button onClick={() => handleVote('YES')}
                disabled={stage !== 'idle' && stage !== 'done'}
                className={`relative py-3.5 rounded-xl text-sm font-bold transition-all duration-300 ${
                  choice === 'YES' ? 'bg-yes-500/20 text-yes-400 border-2 border-yes-500/40 shadow-[0_0_20px_-4px_rgba(0,220,130,0.3)]'
                    : 'bg-white/[0.03] text-surface-300 border border-white/[0.06] hover:border-yes-500/30 hover:text-yes-400'
                } disabled:opacity-50 disabled:cursor-not-allowed`}>YES · 62%</button>
              <button onClick={() => handleVote('NO')}
                disabled={stage !== 'idle' && stage !== 'done'}
                className={`relative py-3.5 rounded-xl text-sm font-bold transition-all duration-300 ${
                  choice === 'NO' ? 'bg-no-500/20 text-no-400 border-2 border-no-500/40 shadow-[0_0_20px_-4px_rgba(255,71,87,0.3)]'
                    : 'bg-white/[0.03] text-surface-300 border border-white/[0.06] hover:border-no-500/30 hover:text-no-400'
                } disabled:opacity-50 disabled:cursor-not-allowed`}>NO · 38%</button>
            </div>

            {/* Progress */}
            {stage !== 'idle' && (
              <div className="flex items-center gap-1 mb-5">
                {steps.map((s, i) => (
                  <div key={s.key} className="flex items-center flex-1">
                    <div className={`flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold transition-all duration-500 ${
                      reached(s.key) ? 'bg-brand-400 text-surface-950' : 'bg-white/[0.06] text-surface-500'
                    }`}>{past(s.key) || stage === 'done' ? '✓' : i + 1}</div>
                    <span className={`ml-1.5 text-[11px] font-medium transition-colors duration-300 ${
                      reached(s.key) ? 'text-brand-400' : 'text-surface-600'
                    }`}>{s.label}</span>
                    {i < steps.length - 1 && (
                      <div className={`flex-1 h-px mx-2 transition-colors duration-500 ${
                        past(s.key) || stage === 'done' ? 'bg-brand-400/40' : 'bg-white/[0.06]'
                      }`} />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Terminal */}
            {stage !== 'idle' && choice && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} transition={{ duration: 0.3 }}
                className="rounded-xl overflow-hidden font-mono text-[11px] leading-relaxed"
                style={{ background: 'rgba(0, 8, 16, 0.8)', border: '1px solid rgba(10, 217, 220, 0.06)' }}>
                <div className="flex items-center gap-1.5 px-4 py-2 border-b border-white/[0.04]">
                  <div className="w-2 h-2 rounded-full bg-no-400/60" />
                  <div className="w-2 h-2 rounded-full bg-brand-400/40" />
                  <div className="w-2 h-2 rounded-full bg-yes-400/60" />
                  <span className="ml-2 text-[10px] text-surface-600">cofhejs · fhenix testnet</span>
                </div>

                <div className="p-4 space-y-2.5 overflow-x-auto">
                  {/* 1 — Initialize SDK */}
                  <Line delay={0.1}>
                    <span className="text-surface-500">{'>'} </span>
                    <span className="text-accent-400">import</span>
                    <span className="text-surface-400">{' { '}</span>
                    <span className="text-brand-300">cofhejs</span>
                    <span className="text-surface-400">, </span>
                    <span className="text-brand-300">Encryptable</span>
                    <span className="text-surface-400">{' } '}</span>
                    <span className="text-accent-400">from</span>
                    <span className="text-yes-400/70"> "cofhejs/web"</span>
                  </Line>
                  <Line delay={0.3}>
                    <span className="text-surface-500">{'>'} </span>
                    <span className="text-brand-400">await </span>
                    <span className="text-white">cofhejs</span>
                    <span className="text-surface-400">.</span>
                    <span className="text-brand-300">initialize</span>
                    <span className="text-surface-400">{'({ '}</span>
                    <span className="text-surface-300">provider</span>
                    <span className="text-surface-400">, </span>
                    <span className="text-surface-300">signer</span>
                    <span className="text-surface-400">{' })'}</span>
                    {active('init') && <Blink text=" ●" />}
                    {(past('init') || stage === 'done') && <span className="text-yes-400/70"> ✓</span>}
                  </Line>

                  {/* 2 — Encrypt with real API */}
                  {reached('encrypt') && (<>
                    <Line delay={0.1}>
                      <span className="text-surface-600 text-[10px]">{'// '} Client-side FHE encryption — plaintext never leaves your browser</span>
                    </Line>
                    <Line delay={0.2}>
                      <span className="text-surface-500">{'>'} </span>
                      <span className="text-accent-400">const </span>
                      <span className="text-surface-300">encrypted</span>
                      <span className="text-surface-400"> = </span>
                      <span className="text-brand-400">await </span>
                      <span className="text-white">cofhejs</span>
                      <span className="text-surface-400">.</span>
                      <span className="text-brand-300">encrypt</span>
                      <span className="text-surface-400">{'(['}</span>
                    </Line>
                    <Line delay={0.35}>
                      <span className="text-surface-400 ml-4">{'  '}</span>
                      <span className="text-white">Encryptable</span>
                      <span className="text-surface-400">.</span>
                      <span className="text-brand-300">uint32</span>
                      <span className="text-surface-400">(</span>
                      <span className="text-accent-400">{outcomeId(choice)}</span>
                      <span className="text-surface-400">)</span>
                      <span className="text-surface-600">,{'  '}// outcome: {choice}</span>
                    </Line>
                    <Line delay={0.45}>
                      <span className="text-surface-400 ml-4">{'  '}</span>
                      <span className="text-white">Encryptable</span>
                      <span className="text-surface-400">.</span>
                      <span className="text-brand-300">uint64</span>
                      <span className="text-surface-400">(</span>
                      <span className="text-accent-400">{amount}n</span>
                      <span className="text-surface-400">)</span>
                      <span className="text-surface-600">,{'  '}// amount: {amount} ETH</span>
                    </Line>
                    <Line delay={0.55}>
                      <span className="text-surface-400">])</span>
                      {active('encrypt') && <Blink text="  encrypting..." />}
                      {(past('encrypt') || stage === 'done') && <span className="text-yes-400/70"> ✓</span>}
                    </Line>
                  </>)}

                  {/* 3 — Encrypted result + contract call */}
                  {reached('send') && (<>
                    <Line delay={0.1}>
                      <span className="text-surface-600 text-[10px]">{'// '} Result: CoFheInUint32 + CoFheInUint64 — ctHash, securityZone, utype, signature</span>
                    </Line>
                    <Line delay={0.2}>
                      <span className="text-surface-500">{'>'} </span>
                      <span className="text-surface-300">encrypted</span>
                      <span className="text-surface-400">.data[0].</span>
                      <span className="text-brand-300">ctHash</span>
                      <span className="text-surface-400"> → </span>
                      <span className="text-accent-400">0x7a3f8b2d...e91c4f07</span>
                    </Line>
                    <Line delay={0.35}>
                      <span className="text-surface-600 text-[10px]">{'// '} Submit to Solidity contract — receives InEuint32, InEuint64</span>
                    </Line>
                    <Line delay={0.45}>
                      <span className="text-surface-500">{'>'} </span>
                      <span className="text-accent-400">const </span>
                      <span className="text-surface-300">tx</span>
                      <span className="text-surface-400"> = </span>
                      <span className="text-brand-400">await </span>
                      <span className="text-white">market</span>
                      <span className="text-surface-400">.</span>
                      <span className="text-brand-300">placeBet</span>
                      <span className="text-surface-400">(</span>
                    </Line>
                    <Line delay={0.55}>
                      <span className="text-surface-400 ml-4">{'  '}encrypted.data[</span>
                      <span className="text-accent-400">0</span>
                      <span className="text-surface-400">],{'  '}</span>
                      <span className="text-surface-600">// InEuint32 outcome</span>
                    </Line>
                    <Line delay={0.6}>
                      <span className="text-surface-400 ml-4">{'  '}encrypted.data[</span>
                      <span className="text-accent-400">1</span>
                      <span className="text-surface-400">]{'   '}</span>
                      <span className="text-surface-600">// InEuint64 amount</span>
                    </Line>
                    <Line delay={0.65}>
                      <span className="text-surface-400">)</span>
                      {active('send') && <Blink text="  tx pending..." />}
                      {(past('send') || stage === 'done') && <span className="text-yes-400/70"> ✓</span>}
                    </Line>
                  </>)}

                  {/* 4 — On-chain Solidity execution */}
                  {reached('confirm') && (<>
                    <Line delay={0.1}>
                      <span className="text-surface-600 text-[10px]">{'// '} Solidity: FHE.asEuint32(_outcome) → euint32 stored on-chain</span>
                    </Line>
                    <Line delay={0.2}>
                      <span className="text-surface-600 text-[10px]">{'// '} FHE.add(pool.reserves, amount) — computed without decryption</span>
                    </Line>
                    <Line delay={0.3}>
                      <span className="text-surface-600 text-[10px]">{'// '} FHE.allowSender(position) — only you can unseal via permit</span>
                    </Line>
                    <Line delay={0.45}>
                      <span className="text-surface-500">{'>'} </span>
                      <span className="text-yes-400">✓ confirmed</span>
                      <span className="text-surface-500"> block </span>
                      <span className="text-surface-400">4,821,337</span>
                      {active('confirm') && <Blink text=" ●" />}
                    </Line>
                  </>)}

                  {/* 5 — Final */}
                  {stage === 'done' && (
                    <Line delay={0.2}>
                      <div className="mt-1 pt-2 border-t border-white/[0.04]">
                        <span className="text-surface-500">{'>'} </span>
                        <span className="text-brand-300">Validators processed only ciphertext.</span>
                        <div className="ml-4 mt-1 text-surface-500 text-[10px]">
                          Your outcome, amount, and position are encrypted as euint32/euint64.
                          <br />Only you can decrypt via <span className="text-brand-400">cofhejs.unseal()</span> with your FHE permit.
                        </div>
                      </div>
                    </Line>
                  )}
                </div>
              </motion.div>
            )}

            {/* Reset */}
            {stage === 'done' && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="mt-4 text-center">
                <button onClick={reset} className="text-xs text-surface-500 hover:text-brand-400 transition-colors">↻ Try again</button>
              </motion.div>
            )}
          </div>
        </motion.div>
      </div>
    </section>
  )
}

// ── Smooth word rotation — GPU-only (opacity + transform + blur) ──
function RotatingWords({ words, interval = 3500 }: { words: string[]; interval?: number }) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setIndex(i => (i + 1) % words.length), interval)
    return () => clearInterval(timer)
  }, [words.length, interval])

  return (
    <span className="inline-block relative" style={{ height: '1.15em', verticalAlign: 'bottom' }}>
      {/* Invisible longest word to reserve width */}
      <span className="invisible" aria-hidden="true">
        {words.reduce((a, b) => a.length >= b.length ? a : b)}
      </span>
      <AnimatePresence mode="wait">
        <motion.span
          key={words[index]}
          className="gradient-text absolute left-0 top-0 whitespace-nowrap"
          style={{ textShadow: '0 0 30px rgba(10,217,220,0.15)' }}
          initial={{ opacity: 0, y: 20, filter: 'blur(8px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -20, filter: 'blur(8px)' }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          {words[index]}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

const HERO_SLIDE_INTERVAL_MS = 7000

const heroDeckVariants = {
  enter: { opacity: 0, x: 28, scale: 0.985 } as const,
  center: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] },
  } as const,
  exit: {
    opacity: 0,
    x: -28,
    scale: 0.99,
    transition: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
  } as const,
}

function HeroFeaturedCard({ market }: { market: Market }) {
  const timeRemaining = useLiveCountdown(market.deadlineTimestamp, market.timeRemaining)
  const catColor = getCategoryColor(market.category)
  const thumbUrl = getMarketThumbnail(market.question, market.category, market.thumbnailUrl)
  const useContain = isContainThumbnail(thumbUrl)

  return (
    <div className="landing-market-card relative rounded-2xl overflow-hidden">
      <div className="absolute top-0 right-0 w-48 h-48 bg-gradient-to-bl from-brand-400/[0.03] to-transparent rounded-full blur-3xl" />

      <div className="relative p-6 lg:p-8">
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold ${catColor.text}`}
              style={{ background: 'rgba(255,255,255,0.03)' }}>
              {getCategoryEmoji(market.category)} {getCategoryName(market.category)}
            </span>
            {(market.tags?.includes('Hot') || market.tags?.includes('Trending') || market.tags?.includes('Featured')) && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold text-brand-400 bg-brand-500/8">
                <Zap className="w-3 h-3" />
                Hot
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-yes-500/10">
            <div className="w-1.5 h-1.5 rounded-full bg-yes-400 animate-pulse" />
            <span className="text-[10px] font-semibold text-yes-400 uppercase tracking-wider">Live</span>
          </div>
        </div>

        <div className="flex gap-3 mb-6">
          <div className={`w-11 h-11 rounded-xl overflow-hidden shrink-0 bg-surface-800 ${useContain ? 'p-1.5 flex items-center justify-center' : ''}`}>
            <img src={thumbUrl} alt="" className={`w-full h-full ${useContain ? 'object-contain' : 'object-cover'}`} loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          </div>
          <h3 className="font-display text-xl lg:text-2xl font-bold text-white leading-snug">
            {market.question}
          </h3>
        </div>

        <div className="flex items-baseline gap-2 mb-4">
          <span className="text-3xl font-display font-bold tabular-nums" style={{ color: market.yesPercentage >= 50 ? '#00dc82' : '#ff4757' }}>
            {formatPercentage(market.yesPercentage)}
          </span>
          <span className="text-sm text-surface-400">probability</span>
        </div>

        <div className="w-full h-1.5 rounded-full bg-surface-700/40 overflow-hidden mb-6">
          <div className="h-full rounded-full bg-yes-500 transition-all duration-700" style={{ width: `${market.yesPercentage}%` }} />
        </div>

        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-yes-500/[0.04]">
            <span className="text-xs font-medium text-surface-300">Yes</span>
            <span className="text-sm font-bold text-yes-400 tabular-nums">{formatPercentage(market.yesPercentage)}</span>
          </div>
          <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-no-500/[0.04]">
            <span className="text-xs font-medium text-surface-300">No</span>
            <span className="text-sm font-bold text-no-400 tabular-nums">{formatPercentage(market.noPercentage)}</span>
          </div>
        </div>

        <div className="flex items-center gap-4 pt-5 text-surface-500">
          <div className="flex items-center gap-1.5 text-surface-500">
            <BarChart3 className="w-3.5 h-3.5" />
            <span className="text-xs tabular-nums">{formatCredits(market.totalVolume, 0)} {market.tokenType ?? 'ETH'}</span>
          </div>
          <div className="flex items-center gap-1.5 text-surface-500">
            <Users className="w-3.5 h-3.5" />
            <span className="text-xs tabular-nums">{market.totalBets}</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-surface-500">
            <Clock className="w-3.5 h-3.5" />
            <span className="text-xs">{timeRemaining}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function HeroCompactCard({ market }: { market: Market }) {
  const timeRemaining = useLiveCountdown(market.deadlineTimestamp, market.timeRemaining)

  return (
    <div className="landing-market-card rounded-xl p-4 transition-all duration-300">
      <p className="text-sm font-semibold text-white line-clamp-1 mb-3">
        {market.question}
      </p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs text-surface-500 flex items-center gap-1 tabular-nums">
            <TrendingUp className="w-3 h-3" />
            {formatCredits(market.totalVolume, 0)} vol
          </span>
          <span className="text-xs text-surface-600">·</span>
          <span className="text-xs text-surface-500 tabular-nums">{timeRemaining}</span>
        </div>
        <span className="text-lg font-display font-bold tabular-nums" style={{ color: market.yesPercentage >= 50 ? '#00dc82' : '#ff4757' }}>
          {formatPercentage(market.yesPercentage)}
        </span>
      </div>
    </div>
  )
}

function HeroCompactCards({ markets }: { markets: Market[] }) {
  const compactMarkets = markets.slice(0, 2)
  const placeholderCount = Math.max(0, 2 - compactMarkets.length)

  return (
    <div className="grid grid-cols-2 gap-3">
      {compactMarkets.map((market) => (
        <HeroCompactCard key={market.id} market={market} />
      ))}

      {Array.from({ length: placeholderCount }, (_, index) => (
        <div key={`hero-placeholder-${index}`} className="landing-market-card rounded-xl p-4 opacity-60">
          <p className="text-sm font-semibold text-surface-300">
            More markets coming soon
          </p>
          <p className="mt-2 text-xs leading-6 text-surface-500">
            This spot will fill automatically as more trending markets appear.
          </p>
        </div>
      ))}
    </div>
  )
}

function HeroTrendingSlider() {
  const { markets, fetchMarkets, isLoading } = useRealMarketsStore()
  const [currentSlide, setCurrentSlide] = useState(0)

  useEffect(() => {
    if (markets.length === 0) void fetchMarkets()
  }, [markets.length, fetchMarkets])

  const heroMarkets = useMemo(() => {
    const active = markets.filter(m => m.status === 1 && m.timeRemaining !== 'Ended')
    const tagged = active
      .filter(m => m.tags?.includes('Hot') || m.tags?.includes('Trending') || m.tags?.includes('Featured'))
      .sort((a, b) => Number(b.totalVolume - a.totalVolume))
    const untagged = active
      .filter(m => !m.tags?.includes('Hot') && !m.tags?.includes('Trending') && !m.tags?.includes('Featured'))
      .sort((a, b) => Number(b.totalVolume - a.totalVolume))

    return [...tagged, ...untagged].slice(0, 6)
  }, [markets])

  useEffect(() => {
    if (heroMarkets.length === 0) {
      setCurrentSlide(0)
      return
    }

    if (currentSlide >= heroMarkets.length) {
      setCurrentSlide(0)
    }
  }, [currentSlide, heroMarkets.length])

  useEffect(() => {
    if (heroMarkets.length <= 1) return

    const interval = window.setInterval(() => {
      setCurrentSlide(prev => (prev + 1) % heroMarkets.length)
    }, HERO_SLIDE_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [heroMarkets.length])

  const visibleMarkets = useMemo(() => {
    if (heroMarkets.length === 0) return []
    const count = Math.min(heroMarkets.length, 3)
    return Array.from({ length: count }, (_, offset) => heroMarkets[(currentSlide + offset) % heroMarkets.length])
  }, [currentSlide, heroMarkets])

  const featuredMarket = visibleMarkets[0] ?? null
  const compactMarkets = visibleMarkets.slice(1)

  if (isLoading && heroMarkets.length === 0) {
    return (
      <div className="space-y-4">
        <div className="landing-market-card rounded-2xl p-6 lg:p-8 animate-pulse">
          <div className="h-4 bg-surface-700 rounded w-1/4 mb-6" />
          <div className="h-6 bg-surface-700 rounded w-3/4 mb-6" />
          <div className="h-8 bg-surface-700 rounded w-1/3 mb-6" />
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="h-12 bg-surface-800 rounded-xl" />
            <div className="h-12 bg-surface-800 rounded-xl" />
          </div>
          <div className="flex gap-4"><div className="h-3 bg-surface-800 rounded w-16" /><div className="h-3 bg-surface-800 rounded w-16" /></div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {[0, 1].map((item) => (
            <div key={item} className="landing-market-card rounded-xl p-4 animate-pulse">
              <div className="h-4 bg-surface-700 rounded w-3/4 mb-3" />
              <div className="h-3 bg-surface-800 rounded w-1/2" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (heroMarkets.length === 0) {
    return (
      <div className="landing-market-card rounded-2xl p-8 text-left">
        <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-brand-300/70">
          Hero Spotlight
        </p>
        <h3 className="mt-3 font-display text-2xl font-bold text-white">
          Trending markets will appear here
        </h3>
        <p className="mt-3 max-w-xl text-sm leading-7 text-surface-400">
          Once live markets have enough activity, the landing hero will rotate through the three strongest signals automatically.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={visibleMarkets.map(m => m.id).join('-')}
          variants={heroDeckVariants}
          initial="enter"
          animate="center"
          exit="exit"
          className="space-y-4"
        >
          {featuredMarket && <HeroFeaturedCard market={featuredMarket} />}
          <HeroCompactCards markets={compactMarkets} />
        </motion.div>
      </AnimatePresence>

      <div className="flex items-center justify-center gap-2">
        {heroMarkets.map((market, index) => (
          <button
            key={market.id}
            type="button"
            onClick={() => setCurrentSlide(index)}
            className={`h-1.5 rounded-full transition-all duration-300 ${index === currentSlide ? 'w-8 bg-brand-400' : 'w-2 bg-white/[0.18] hover:bg-white/[0.28]'}`}
            aria-label={`Go to hero market ${index + 1}`}
          />
        ))}
      </div>
    </div>
  )
}

const stagger = {
  hidden: { opacity: 0 } as const,
  show: { opacity: 1, transition: { staggerChildren: 0.08 } } as const,
}
const fadeUp = {
  hidden: { opacity: 0, y: 20 } as const,
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } } as const,
}

// ═══════════════════════════════════════════
// LANDING PAGE — Premium Redesign
// ═══════════════════════════════════════════
export function Landing() {
  const navigate = useNavigate()
  const { wallet } = useWalletStore()

  // Track whether user explicitly clicked a login/launch button
  const userInitiatedLogin = useRef(false)

  // After fresh Privy login → navigate to dashboard ONLY if user clicked login
  useEffect(() => {
    const handler = () => {
      if (userInitiatedLogin.current) {
        userInitiatedLogin.current = false
        navigate('/dashboard')
      }
    }
    window.addEventListener('privy:connected', handler)
    return () => window.removeEventListener('privy:connected', handler)
  }, [navigate])

  const handleLaunch = useCallback(() => {
    if (wallet.connected) {
      // Already logged in — go straight to dashboard
      navigate('/dashboard')
    } else {
      // Mark as user-initiated, then trigger Privy login modal
      userInitiatedLogin.current = true
      const privyLogin = (window as any).__privyLogin
      if (privyLogin) privyLogin()
    }
  }, [navigate, wallet.connected])

  return (
    <div className="min-h-screen bg-surface-950 relative overflow-hidden">

      {/* ── Background ── */}
      <div className="fixed inset-0 z-0">
        {/* Mesh gradient */}
        <div className="absolute inset-0"
          style={{
            background: `
              radial-gradient(ellipse at 20% 0%, rgba(10, 217, 220, 0.14) 0%, transparent 50%),
              radial-gradient(ellipse at 80% 100%, rgba(117, 133, 255, 0.08) 0%, transparent 50%),
              radial-gradient(ellipse at 50% 50%, #0a1929 0%, #001623 100%)
            `
          }}
        />
        {/* Subtle floating orbs — CSS animation, zero JS */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute w-[500px] h-[500px] rounded-full top-[10%] left-[5%] bg-brand-400/[0.03] blur-[100px] animate-[float_20s_ease-in-out_infinite]" />
          <div className="absolute w-[400px] h-[400px] rounded-full bottom-[20%] right-[10%] bg-accent-400/[0.025] blur-[100px] animate-[float_25s_ease-in-out_infinite_reverse]" />
          <div className="absolute w-[300px] h-[300px] rounded-full top-[60%] left-[40%] bg-brand-400/[0.02] blur-[80px] animate-[float_18s_ease-in-out_3s_infinite]" />
        </div>
        {/* Grid */}
        <div className="absolute inset-0 opacity-[0.02]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
          }}
        />
        {/* Accent glow */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full bg-brand-400/[0.03] blur-[120px]" />
        {/* Diagonal lines */}
        <div className="absolute top-0 right-0 w-[600px] h-[600px] opacity-[0.015]"
          style={{ backgroundImage: 'repeating-linear-gradient(-45deg, rgba(10,217,220,1) 0, rgba(10,217,220,1) 1px, transparent 0, transparent 40px)' }}
        />
        {/* Noise */}
        <div className="absolute inset-0 opacity-[0.015]"
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")" }}
        />
      </div>

      {/* ── Header ── */}
      <header className="fixed top-0 left-0 right-0 z-40 bg-surface-950/70 backdrop-blur-xl border-b border-brand-400/[0.08]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 lg:h-[72px]">
            <div className="flex items-center gap-3">
              <div className="relative w-10 h-10 rounded-xl overflow-hidden">
                <img src="/logo.svg" alt="Fhenix Markets" className="w-10 h-10 object-cover rounded-xl" />
              </div>
              <span className="font-display text-xl text-white tracking-tight hidden sm:block">
                <span className="gradient-text">Fhenix</span> Markets
              </span>
            </div>
            <nav className="hidden md:flex items-center gap-1">
              <a href="#features" className="px-4 py-2 text-sm font-medium text-surface-400 hover:text-white rounded-lg hover:bg-white/[0.04] transition-all duration-200">Protocol</a>
              <a href="#protocol" className="px-4 py-2 text-sm font-medium text-surface-400 hover:text-white rounded-lg hover:bg-white/[0.04] transition-all duration-200">How It Works</a>
              <a href="#demo" className="px-4 py-2 text-sm font-medium text-surface-400 hover:text-white rounded-lg hover:bg-white/[0.04] transition-all duration-200">Demo</a>
            </nav>
            <button onClick={handleLaunch}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm active:scale-[0.96] transition-all duration-200"
                style={{
                  background: 'linear-gradient(135deg, #0AD9DC 0%, #09c2c5 100%)',
                  color: '#001623',
                  boxShadow: '0 2px 8px rgba(10, 217, 220, 0.25), 0 0 20px -5px rgba(10, 217, 220, 0.3)',
                }}>
                <LayoutDashboard className="w-4 h-4" />
                <span>Launch App</span>
                <ArrowRight className="w-4 h-4" />
              </button>
          </div>
        </div>
      </header>

      {/* ═══════ HERO ═══════ */}
      <section className="relative z-10">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 pt-32 pb-12 w-full">
          <div className="grid lg:grid-cols-12 gap-12 lg:gap-16 items-center">
            {/* Left — Copy */}
            <motion.div className="lg:col-span-5" variants={stagger} initial="hidden" animate="show">
              {/* Badge */}
              <motion.div variants={fadeUp} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-400/[0.06] mb-5">
                <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                <span className="text-xs font-semibold text-brand-400">Live on Fhenix Testnet</span>
              </motion.div>

              <motion.h1 variants={fadeUp} className="font-display text-[3.25rem] lg:text-[4rem] leading-[1.05] tracking-tight text-white mb-6">
                Encrypted Bets.
                <br />
                <RotatingWords words={['Total Privacy.', 'Sealed Predictions.', 'Hidden Positions.']} />
              </motion.h1>

              <motion.p variants={fadeUp} className="text-lg text-surface-400 leading-relaxed mb-8 max-w-lg">
                The prediction market powered by{' '}
                <span className="text-brand-300 font-semibold">Fully Homomorphic Encryption</span>.
                Compute on encrypted data — your bets never leave ciphertext.
              </motion.p>

              <motion.div variants={fadeUp} className="flex items-center gap-4 mb-8">
                <button onClick={handleLaunch}
                    className="flex items-center gap-3 px-7 py-3.5 rounded-xl font-semibold text-sm active:scale-[0.96] transition-all duration-200 group"
                    style={{
                      background: 'linear-gradient(135deg, #0AD9DC 0%, #09c2c5 100%)',
                      color: '#001623',
                      boxShadow: '0 2px 8px rgba(10, 217, 220, 0.25), 0 0 20px -5px rgba(10, 217, 220, 0.3)',
                    }}>
                    <LayoutDashboard className="w-5 h-5" />
                    <span>Enter Markets</span>
                    <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  </button>
                <a href="#protocol" className="btn-secondary px-6 py-3.5 text-sm flex items-center gap-2">
                  How It Works <ChevronRight className="w-4 h-4" />
                </a>
              </motion.div>

              {/* Trust pills */}
              <motion.div variants={fadeUp} className="flex flex-wrap items-center gap-3">
                {[
                  { icon: <Shield className="w-3.5 h-3.5" />, text: 'FHE Coprocessor' },
                  { icon: <Eye className="w-3.5 h-3.5" />, text: 'Encrypted State' },
                  { icon: <Lock className="w-3.5 h-3.5" />, text: 'EVM Compatible' },
                ].map((pill) => (
                  <div key={pill.text} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold text-surface-300 bg-white/[0.02]">
                    <span className="text-brand-400">{pill.icon}</span>
                    <span>{pill.text}</span>
                  </div>
                ))}
              </motion.div>
            </motion.div>

            {/* Right — Hero Market Cards */}
            <motion.div className="lg:col-span-7"
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.7, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}>
              <div className="relative">
                {/* Glow */}
                <div className="absolute -inset-4 bg-gradient-to-br from-brand-400/[0.03] via-transparent to-transparent rounded-3xl blur-3xl" />

                <div className="relative space-y-4">
                  <HeroTrendingSlider />
                </div>
              </div>
            </motion.div>
          </div>
        </div>

        {/* Scroll indicator */}
        <motion.div className="flex justify-center mt-8 mb-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.2 }}>
          <div className="w-5 h-8 rounded-full border border-white/[0.1] flex items-start justify-center p-1.5">
            <motion.div className="w-1 h-1.5 rounded-full bg-brand-400"
              animate={{ y: [0, 8, 0] }} transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }} />
          </div>
        </motion.div>
      </section>

      {/* ═══════ HOW IT WORKS ═══════ */}
      <section id="protocol" className="relative py-24 z-10">
        <div className="absolute left-1/2 -translate-x-1/2 w-[600px] h-px bg-gradient-to-r from-transparent via-brand-400/20 to-transparent" />
        <div className="relative bg-surface-850/50 py-20 mt-8">
          <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8">
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-16">
              <p className="text-xs font-bold uppercase tracking-[0.15em] text-brand-400 mb-4">How It Works</p>
              <h2 className="font-display text-[2.5rem] lg:text-[3rem] leading-[1.1] tracking-tight text-white">
                Predict in{' '}<span className="gradient-text">Four Steps</span>
              </h2>
              <p className="text-surface-400 mt-3">From wallet to encrypted prediction in under a minute</p>
            </motion.div>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
              {[
                { step: '01', icon: Wallet, title: 'Connect Wallet', desc: 'Link any EVM wallet. cofhejs encrypts inputs client-side before broadcast.' },
                { step: '02', icon: Target, title: 'Pick a Market', desc: 'Binary, multi-outcome, or crypto price markets — all with encrypted order flow.' },
                { step: '03', icon: Lock, title: 'Bet in Ciphertext', desc: 'Your amount and outcome are encrypted as euint32. The FHE coprocessor settles without seeing cleartext.' },
                { step: '04', icon: Zap, title: 'Unseal & Collect', desc: 'When the market resolves, unseal your winnings with your FHE permit. Trustless and private.' },
              ].map((s, i) => (
                <motion.div key={s.step} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }} transition={{ delay: i * 0.1 }} className="relative">
                  {i < 3 && (
                    <div className="hidden lg:block absolute top-10 left-[calc(100%+8px)] w-[calc(100%-80px)] h-px bg-gradient-to-r from-white/[0.06] to-transparent" />
                  )}
                  <div className="rounded-2xl p-6 h-full"
                    style={{
                      background: 'linear-gradient(135deg, rgba(8, 32, 48, 0.8) 0%, rgba(4, 20, 32, 0.9) 100%)',
                      border: '1px solid rgba(10, 217, 220, 0.06)',
                      boxShadow: '0 1px 0 0 rgba(255, 255, 255, 0.02) inset, 0 4px 20px -4px rgba(0, 0, 0, 0.4)',
                    }}>
                    <div className="flex items-center gap-3 mb-5">
                      <span className="text-xs font-mono text-brand-400/50">{s.step}</span>
                      <div className="w-10 h-10 rounded-xl bg-brand-400/[0.06] border border-brand-400/[0.1] flex items-center justify-center">
                        <s.icon className="w-5 h-5 text-brand-400" />
                      </div>
                    </div>
                    <h3 className="text-lg font-semibold text-white mb-2">{s.title}</h3>
                    <p className="text-sm text-surface-400 leading-relaxed">{s.desc}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════ FHE DEMO ═══════ */}
      <FHEDemo />

      {/* ═══════ FEATURES — Bento Grid ═══════ */}
      <section id="features" className="relative py-24 z-10">
        <div className="absolute left-1/2 -translate-x-1/2 w-[600px] h-px bg-gradient-to-r from-transparent via-brand-400/20 to-transparent mb-24" />

        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 pt-8">
          <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-16">
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-brand-400 mb-4">Powered by FHE</p>
            <h2 className="font-display text-[2.5rem] lg:text-[3rem] leading-[1.1] tracking-tight text-white">
              Computation on{' '}<span className="gradient-text">Ciphertext.</span>
            </h2>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-5">
            {[
              { icon: <Eye className="w-6 h-6" />, title: 'Encrypted Positions', desc: 'Bets stored as euint32 ciphertext on-chain. The FHE coprocessor computes without decryption.', color: '#0AD9DC' },
              { icon: <Shield className="w-6 h-6" />, title: 'Confidential AMM', desc: 'Liquidity pools operate on encrypted reserves. Price discovery without exposing individual trades.', color: '#00dc82' },
              { icon: <Lock className="w-6 h-6" />, title: 'Permissioned Reveal', desc: 'Only you can unseal your positions via FHE permits. No admin keys, no backdoors.', color: '#7585FF' },
            ].map((f, i) => (
              <motion.div key={f.title} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }} transition={{ delay: i * 0.1 }}
                className="group relative p-8 rounded-2xl transition-all duration-300 hover:border-white/[0.08]"
                style={{
                  background: 'linear-gradient(135deg, rgba(8, 32, 48, 0.8) 0%, rgba(4, 20, 32, 0.9) 100%)',
                  border: '1px solid rgba(10, 217, 220, 0.06)',
                  boxShadow: '0 1px 0 0 rgba(255, 255, 255, 0.02) inset, 0 4px 20px -4px rgba(0, 0, 0, 0.4)',
                }}>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-5 transition-transform group-hover:scale-110"
                  style={{ background: `${f.color}10`, border: `1px solid ${f.color}20`, color: f.color }}>
                  {f.icon}
                </div>
                <h3 className="text-lg font-semibold text-white mb-2 group-hover:text-brand-300 transition-colors">{f.title}</h3>
                <p className="text-sm text-surface-400 leading-relaxed">{f.desc}</p>
              </motion.div>
            ))}
          </div>

          {/* Protocol highlights */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 lg:mt-5">
            {[
              { icon: <BarChart3 className="w-4 h-4" />, label: 'FHE-AMM', sub: 'Encrypted Market Maker' },
              { icon: <Users className="w-4 h-4" />, label: 'CoFHE', sub: 'Off-chain FHE compute' },
              { icon: <Globe className="w-4 h-4" />, label: 'EVM Native', sub: 'Solidity + cofhejs' },
              { icon: <Code className="w-4 h-4" />, label: 'Open Source', sub: 'MIT Licensed' },
            ].map((h) => (
              <div key={h.label} className="flex items-center gap-3 p-4 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                <div className="w-8 h-8 rounded-lg bg-brand-400/[0.08] flex items-center justify-center text-brand-400 flex-shrink-0">{h.icon}</div>
                <div>
                  <p className="text-sm font-semibold text-white leading-tight">{h.label}</p>
                  <p className="text-[11px] text-surface-500">{h.sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════ TRENDING MARKETS ═══════ */}
      <TrendingMarkets />

      {/* ═══════ CTA ═══════ */}
      <section className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-20 z-10 relative">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
          className="relative rounded-3xl p-12 lg:p-16 text-center overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(28, 33, 48, 0.9) 0%, rgba(17, 20, 27, 0.95) 100%)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            boxShadow: '0 8px 32px -8px rgba(0,0,0,0.5), 0 4px 8px -4px rgba(0,0,0,0.3)',
          }}>
          <div className="absolute inset-0 bg-gradient-to-br from-brand-400/[0.04] via-transparent to-yes-400/[0.02]" />
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[500px] h-px bg-gradient-to-r from-transparent via-brand-400/30 to-transparent" />
          <div className="relative z-10">
            <h2 className="font-display text-[2.5rem] lg:text-[3rem] leading-[1.1] tracking-tight text-white mb-4">
              The future is encrypted.
            </h2>
            <p className="text-lg text-surface-400 max-w-lg mx-auto mb-10">
              First prediction market where data stays in ciphertext end-to-end. Built on Fhenix CoFHE.
            </p>
            <div className="flex items-center justify-center gap-4">
              <button onClick={handleLaunch}
                className="flex items-center gap-3 px-8 py-4 rounded-xl font-semibold text-base active:scale-[0.96] transition-all duration-200 group"
                style={{
                  background: 'linear-gradient(135deg, #0AD9DC 0%, #09c2c5 100%)',
                  color: '#001623',
                  boxShadow: '0 2px 8px rgba(10, 217, 220, 0.25), 0 0 30px -5px rgba(10, 217, 220, 0.3)',
                }}>
                Start Trading <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </button>
              <a href="#" className="btn-secondary px-8 py-4 text-base flex items-center gap-2">
                Read Docs <ArrowUpRight className="w-4 h-4" />
              </a>
            </div>
          </div>
        </motion.div>
      </section>

      {/* ═══════ FOOTER ═══════ */}
      <footer className="relative z-10 py-12 border-t border-white/[0.04]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="relative w-9 h-9 rounded-xl overflow-hidden">
                <img src="/logo.svg" alt="Fhenix Markets" className="w-9 h-9 object-cover rounded-xl" />
              </div>
              <span className="font-display text-sm font-semibold text-surface-400">
                <span className="text-white">Fhenix</span> Markets
              </span>
            </div>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-yes-400 animate-pulse" />
                <span className="text-xs text-surface-500">All systems operational</span>
              </div>
              <p className="text-xs text-surface-600">© 2026 Fhenix Markets · Built on Fhenix</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
