import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowRight, ArrowLeft, AlertCircle, CheckCircle2, Lightbulb,
  Shield, Coins, ExternalLink,
  Check, Loader2, AlertTriangle, DollarSign,
  Upload, Link, Image,
} from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWalletStore } from '@/lib/store'
import { cn, sanitizeUrl } from '@/lib/utils'
import {
  createMarket as contractCreateMarket,
  computeQuestionHash,
  parseEth,
  parseContractError,
  ensureSepoliaNetwork,
} from '@/lib/contracts'
import { registerMarketInRegistry, isSupabaseAvailable } from '@/lib/supabase'
import { uploadMarketMetadata, uploadImageToIPFS, isPinataAvailable } from '@/lib/ipfs'
import { devLog, devWarn } from '@/lib/logger'
import { ethers } from 'ethers'
import { DashboardHeader } from '@/components/DashboardHeader'
import { Footer } from '@/components/Footer'

type CreateStep = 'details' | 'timing' | 'review' | 'creating' | 'success' | 'error'

interface MarketFormData {
  question: string
  description: string
  category: number
  numOutcomes: number
  outcomeLabels: string[]
  initialLiquidity: string
  deadlineDate: string
  deadlineTime: string
  resolutionDeadlineDate: string
  resolutionDeadlineTime: string
  resolutionSource: string
  tokenType: 'ETH'
  thumbnailUrl: string
}

const categories = [
  { id: 1, name: 'Politics', emoji: '🏛' },
  { id: 3, name: 'Crypto', emoji: '₿' },
  { id: 2, name: 'Sports', emoji: '⚽' },
  { id: 6, name: 'Macro', emoji: '📈' },
  { id: 5, name: 'AI & Tech', emoji: '🤖' },
  { id: 4, name: 'Culture', emoji: '🎭' },
  { id: 8, name: 'Climate', emoji: '🌍' },
  { id: 7, name: 'Science', emoji: '🔬' },
]

const initialFormData: MarketFormData = {
  question: '', description: '', category: 3, numOutcomes: 2,
  outcomeLabels: ['Yes', 'No', '', ''], initialLiquidity: '0.01',
  deadlineDate: '', deadlineTime: '23:59',
  resolutionDeadlineDate: '', resolutionDeadlineTime: '23:59',
  resolutionSource: '', tokenType: 'ETH',
  thumbnailUrl: '',
}

const DRAFT_KEY = 'fhenix_create_market_draft'
function saveDraft(data: MarketFormData) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)) } catch {} }
function loadDraft(): MarketFormData | null { try { const raw = localStorage.getItem(DRAFT_KEY); return raw ? JSON.parse(raw) : null } catch { return null } }
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY) } catch {} }
function hasFormContent(data: MarketFormData) { return data.question.trim() !== '' || data.description.trim() !== '' }

// ── Thumbnail Input (URL or file upload) ──
function ThumbnailInput({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const [mode, setMode] = useState<'url' | 'upload'>(value && !value.startsWith('blob:') ? 'url' : 'url')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate
    if (!file.type.startsWith('image/')) {
      setUploadError('Please select an image file')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('Image must be under 5MB')
      return
    }

    setUploadError(null)
    setUploading(true)

    // Show local preview immediately
    const localPreview = URL.createObjectURL(file)
    onChange(localPreview)

    // Upload to IPFS
    try {
      const ipfsUrl = await uploadImageToIPFS(file)
      if (ipfsUrl) {
        onChange(ipfsUrl)
        URL.revokeObjectURL(localPreview)
      } else {
        setUploadError('Upload failed. Using local preview — image may not persist.')
      }
    } catch {
      setUploadError('Upload failed. Using local preview.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <label className="text-sm font-medium text-white mb-2 block">Thumbnail Image</label>
      {/* Mode toggle */}
      <div className="flex items-center gap-1 p-0.5 rounded-lg bg-white/[0.02] border border-white/[0.04] w-fit mb-3">
        <button onClick={() => setMode('url')}
          className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
            mode === 'url' ? 'bg-white/[0.06] text-white' : 'text-surface-500 hover:text-surface-300')}>
          <Link className="w-3 h-3" /> URL
        </button>
        <button onClick={() => setMode('upload')}
          className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
            mode === 'upload' ? 'bg-white/[0.06] text-white' : 'text-surface-500 hover:text-surface-300')}>
          <Upload className="w-3 h-3" /> Upload
        </button>
      </div>

      <div className="flex gap-3 items-start">
        <div className="flex-1">
          {mode === 'url' ? (
            <>
              <input type="text" value={value} onChange={(e) => onChange(e.target.value)}
                placeholder="https://... image URL (optional)" className="input-field w-full" />
              <p className="text-2xs text-surface-500 mt-1.5">Paste an image URL. Leave empty for auto-detection.</p>
            </>
          ) : (
            <>
              <input ref={fileRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />
              <button onClick={() => fileRef.current?.click()} disabled={uploading}
                className={cn(
                  'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed transition-all',
                  value && !uploading
                    ? 'border-yes-500/30 bg-yes-500/[0.04] text-yes-400'
                    : 'border-white/[0.08] bg-white/[0.02] text-surface-400 hover:border-white/[0.15] hover:bg-white/[0.04]'
                )}>
                {uploading ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Uploading to IPFS...</>
                ) : value ? (
                  <><Check className="w-4 h-4" /> Image selected — click to change</>
                ) : (
                  <><Image className="w-4 h-4" /> Choose image file</>
                )}
              </button>
              <p className="text-2xs text-surface-500 mt-1.5">
                {isPinataAvailable() ? 'JPG, PNG, WebP — max 5MB. Uploaded to IPFS.' : 'IPFS not configured. Image will be stored as local preview only.'}
              </p>
              {uploadError && <p className="text-2xs text-no-400 mt-1">{uploadError}</p>}
            </>
          )}
        </div>

        {/* Preview */}
        <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 bg-surface-800 border border-white/[0.06] flex items-center justify-center">
          {value ? (
            <img src={value} alt="Preview" className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : (
            <Image className="w-4 h-4 text-surface-600" />
          )}
        </div>
      </div>

      {/* Clear button */}
      {value && (
        <button onClick={() => { onChange(''); if (fileRef.current) fileRef.current.value = '' }}
          className="text-2xs text-surface-500 hover:text-no-400 mt-2 transition-colors">
          Remove thumbnail
        </button>
      )}
    </div>
  )
}

export function CreateMarketPage() {
  const navigate = useNavigate()
  const { wallet } = useWalletStore()
  // Contract calls via contracts.ts
  const [step, setStep] = useState<CreateStep>('details')
  const [formData, setFormData] = useState<MarketFormData>(initialFormData)
  const [error, setError] = useState<string | null>(null)
  const [marketId, setMarketId] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [isSlowTransaction, setIsSlowTransaction] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (step === 'details') {
      const draft = loadDraft()
      if (draft && hasFormContent(draft)) setFormData(draft)
    }
  }, [])

  const updateForm = (updates: Partial<MarketFormData>) => {
    setFormData(prev => { const next = { ...prev, ...updates }; saveDraft(next); return next })
  }

  const validateDetails = (): boolean => {
    if (!formData.question.trim()) { setError('Please enter a market question'); return false }
    if (formData.question.trim().length < 20) { setError('Question must be at least 20 characters'); return false }
    if (formData.question.trim().length > 500) { setError('Question must be at most 500 characters'); return false }
    if (!formData.category) { setError('Please select a category'); return false }
    if (formData.resolutionSource.trim()) {
      const src = formData.resolutionSource.trim()
      if ((src.includes('://') || src.startsWith('http')) && !sanitizeUrl(src)) {
        setError('Resolution source URL is invalid. Must be a valid https:// URL.'); return false
      }
    }
    setError(null); return true
  }

  const validateTiming = (): boolean => {
    const deadline = new Date(`${formData.deadlineDate}T${formData.deadlineTime}`)
    const resDeadline = new Date(`${formData.resolutionDeadlineDate}T${formData.resolutionDeadlineTime}`)
    const now = new Date()
    if (!formData.deadlineDate) { setError('Please set a betting deadline'); return false }
    if (deadline <= now) { setError('Deadline must be in the future'); return false }
    if (!formData.resolutionDeadlineDate) { setError('Please set a resolution deadline'); return false }
    if (resDeadline <= deadline) { setError('Resolution deadline must be after betting deadline'); return false }
    const minResMs = 6 * 60 * 60 * 1000
    if (resDeadline.getTime() - deadline.getTime() < minResMs) {
      setError('Resolution deadline must be at least 6 hours after betting deadline (3h voting + 3h dispute window)')
      return false
    }
    const liq = parseFloat(formData.initialLiquidity)
    if (isNaN(liq) || liq < 0.01) { setError('Initial liquidity must be at least 0.01 ETH'); return false }
    if (liq > 10_000) { setError('Initial liquidity cannot exceed 10,000 tokens'); return false }
    setError(null); return true
  }

  const handleNext = () => {
    if (step === 'details' && validateDetails()) setStep('timing')
    else if (step === 'timing' && validateTiming()) setStep('review')
  }

  const handleBack = () => {
    if (step === 'timing') setStep('details')
    else if (step === 'review') setStep('timing')
  }

  // ═══════════════════════════════════════════
  // handleCreate — EXACT same logic from CreateMarketModal
  // ═══════════════════════════════════════════
  const handleCreate = async () => {
    if (isSubmitting) return
    if (!validateTiming()) { setStep('timing'); return }
    setIsSubmitting(true); setStep('creating'); setError(null)
    try {
      await ensureSepoliaNetwork()

      const questionHash = computeQuestionHash(formData.question)
      const deadlineDate = new Date(`${formData.deadlineDate}T${formData.deadlineTime}`)
      const resolutionDate = new Date(`${formData.resolutionDeadlineDate}T${formData.resolutionDeadlineTime}`)
      const deadlineTimestamp = BigInt(Math.floor(deadlineDate.getTime() / 1000))
      const resolutionTimestamp = BigInt(Math.floor(resolutionDate.getTime() / 1000))

      const liquidityWei = parseEth(formData.initialLiquidity || '10')

      if (deadlineTimestamp <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('Deadline must be in the future')
      if (resolutionTimestamp <= deadlineTimestamp) throw new Error('Resolution deadline must be after betting deadline')

      setIsSlowTransaction(false)
      const slowTimer = setTimeout(() => setIsSlowTransaction(true), 30_000)

      let receipt: ethers.TransactionReceipt
      try {
        receipt = await contractCreateMarket(
          questionHash,
          Number(formData.category),
          Number(formData.numOutcomes),
          deadlineTimestamp,
          resolutionTimestamp,
          wallet.address!, // resolver = creator
          liquidityWei,
        )
      } finally { clearTimeout(slowTimer) }

      const transactionId = receipt.hash
      setTxHash(transactionId)
      const activeLabels = formData.outcomeLabels.slice(0, formData.numOutcomes)

      // Parse MarketCreated event to get the real on-chain marketId
      const marketCreatedTopic = ethers.id('MarketCreated(bytes32,address,bytes32,uint8,uint64)')
      console.log('[CreateMarket] Looking for topic:', marketCreatedTopic)
      console.log('[CreateMarket] Receipt logs count:', receipt.logs.length)
      receipt.logs.forEach((log: any, i: number) => {
        console.log(`[CreateMarket] Log[${i}] address=${log.address} topic0=${log.topics[0]}`)
      })
      const marketCreatedLog = receipt.logs.find((log: any) => log.topics[0] === marketCreatedTopic)
      console.log('[CreateMarket] Found MarketCreated log:', !!marketCreatedLog)
      const onChainMarketId = marketCreatedLog?.topics[1] || questionHash
      devLog('[CreateMarket] On-chain marketId:', onChainMarketId)
      if (!marketCreatedLog) {
        console.error('[CreateMarket] WARNING: MarketCreated event NOT found! Falling back to questionHash. This market will NOT work for trading!')
      }

      let ipfsCid: string | null = null
      if (isPinataAvailable()) {
        try {
          ipfsCid = await uploadMarketMetadata({
            version: 1, question: formData.question, description: formData.description || '',
            category: formData.category, outcomeLabels: activeLabels,
            resolutionSource: formData.resolutionSource || '', questionHash,
            creator: wallet.address!, tokenType: formData.tokenType, createdAt: Date.now(),
          })
        } catch (err) { devWarn('[CreateMarket] IPFS upload failed:', err) }
      }

      setMarketId(onChainMarketId); clearDraft(); setStep('success')

      if (isSupabaseAvailable()) {
        registerMarketInRegistry({
          market_id: onChainMarketId, question_hash: questionHash, question_text: formData.question,
          description: formData.description || undefined, resolution_source: formData.resolutionSource || undefined,
          thumbnail_url: formData.thumbnailUrl || undefined,
          category: formData.category, creator_address: wallet.address!, transaction_id: transactionId,
          created_at: Date.now(), ipfs_cid: ipfsCid || undefined, outcome_labels: JSON.stringify(activeLabels),
        }).catch(err => devWarn('[CreateMarket] Supabase register failed:', err))
      }
    } catch (err: unknown) {
      console.error('[CreateMarket] FULL ERROR:', err)
      const errorMsg = parseContractError(err)
      console.error('[CreateMarket] Parsed error:', errorMsg)
      setError(errorMsg); setStep('error'); setIsSubmitting(false)
    }
  }

  const deadline = formData.deadlineDate ? new Date(`${formData.deadlineDate}T${formData.deadlineTime}`) : null
  const resolutionDeadline = formData.resolutionDeadlineDate ? new Date(`${formData.resolutionDeadlineDate}T${formData.resolutionDeadlineTime}`) : null
  const selectedCategory = categories.find(c => c.id === formData.category)
  const today = new Date().toISOString().split('T')[0]
  const minResDate = formData.deadlineDate || today
  const totalSteps = 3
  const stepNum = step === 'details' ? 1 : step === 'timing' ? 2 : 3

  if (!wallet.connected) return null

  return (
    <div className="min-h-screen bg-surface-950 flex flex-col">
      <DashboardHeader />
      <main className="flex-1 pt-24 lg:pt-28 pb-20">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-12 gap-8">
            {/* Main Form */}
            <div className="lg:col-span-7 xl:col-span-8">
              {/* Header */}
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-10">
                <h1 className="font-display text-[2.5rem] leading-[1.1] tracking-tight text-white mb-2">Create Market</h1>
                <p className="text-surface-400">Launch a new prediction market on Fhenix</p>
              </motion.div>

              {/* Progress bar */}
              {(step === 'details' || step === 'timing' || step === 'review') && (
                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="mb-10">
                  <div className="flex items-center gap-2 mb-3">
                    {Array.from({ length: totalSteps }).map((_, i) => (
                      <div key={i} className="flex-1 h-1 rounded-full overflow-hidden bg-white/[0.04]">
                        <div className="h-full rounded-full transition-all duration-500"
                          style={{ width: stepNum > i + 1 ? '100%' : stepNum === i + 1 ? '50%' : '0%', background: stepNum > i ? 'linear-gradient(90deg, #0AD9DC, #67e8f9)' : 'transparent' }} />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-surface-500">Step {stepNum} of {totalSteps}</span>
                    <span className="text-xs text-brand-400 font-semibold">{['Market Details', 'Timing & Liquidity', 'Review & Publish'][stepNum - 1]}</span>
                  </div>
                </motion.div>
              )}

              {/* Form Steps */}
              <AnimatePresence mode="wait">
                {step === 'details' && (
                  <motion.div key="s1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.3 }}>
                    <div className="glass-card p-6 space-y-6">
                      <div>
                        <label className="text-sm font-medium text-white mb-2 block">Market Question *</label>
                        <textarea value={formData.question} onChange={(e) => updateForm({ question: e.target.value })} placeholder="Will Bitcoin reach $150,000 by end of Q1 2026?" className="input-field w-full h-24 resize-none" maxLength={500} />
                        <p className="text-2xs text-surface-500 mt-2">{formData.question.length}/500 — Frame as a clear question with unambiguous resolution</p>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-white mb-2 block">Description</label>
                        <textarea value={formData.description} onChange={(e) => updateForm({ description: e.target.value })} placeholder="Provide detailed context and resolution criteria..." rows={4} className="input-field w-full resize-none" maxLength={1500} />
                      </div>
                      <div>
                        <label className="text-sm font-medium text-white mb-3 block">Category *</label>
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                          {categories.map((cat) => (
                            <button key={cat.id} onClick={() => updateForm({ category: cat.id })}
                              className={cn('flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-medium transition-all duration-200',
                                formData.category === cat.id ? 'bg-brand-400/[0.12] text-brand-400 border border-brand-400/[0.2]' : 'bg-white/[0.02] text-surface-400 border border-white/[0.04] hover:bg-white/[0.04]')}>
                              <span>{cat.emoji}</span>{cat.name}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-white mb-2 block">Resolution Source</label>
                        <input type="text" value={formData.resolutionSource} onChange={(e) => updateForm({ resolutionSource: e.target.value })} placeholder="e.g., CoinGecko API, Official announcement..." className="input-field w-full" />
                      </div>
                      <ThumbnailInput
                        value={formData.thumbnailUrl}
                        onChange={(url) => updateForm({ thumbnailUrl: url })}
                      />
                      <div>
                        <label className="text-sm font-medium text-white mb-3 block">Outcomes</label>
                        <div className="grid grid-cols-3 gap-3 mb-4">
                          {[2, 3, 4].map((n) => (
                            <button key={n} onClick={() => { const labels = [...formData.outcomeLabels]; if (n >= 3 && !labels[2]) labels[2] = 'Option C'; if (n >= 4 && !labels[3]) labels[3] = 'Option D'; updateForm({ numOutcomes: n, outcomeLabels: labels }) }}
                              className={cn('p-3 rounded-xl text-center transition-all', formData.numOutcomes === n ? 'bg-brand-400/[0.12] border border-brand-400/[0.2]' : 'bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04]')}>
                              <span className="text-lg font-semibold text-white block">{n}</span>
                              <span className="text-2xs text-surface-400">{n === 2 ? 'Binary' : `${n}-way`}</span>
                            </button>
                          ))}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {Array.from({ length: formData.numOutcomes }, (_, i) => (
                            <input key={i} type="text" value={formData.outcomeLabels[i] || ''} onChange={(e) => { const l = [...formData.outcomeLabels]; l[i] = e.target.value; updateForm({ outcomeLabels: l }) }} placeholder={`Outcome ${i + 1}`} className="input-field text-sm" />
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-white mb-3 block">Betting Token</label>
                        <div className="p-3 rounded-xl bg-brand-400/[0.12] border border-brand-400/[0.2] text-center">
                          <span className="text-lg font-semibold text-white block">ETH</span>
                          <span className="text-2xs text-surface-400">Native</span>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}

                {step === 'timing' && (
                  <motion.div key="s2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.3 }}>
                    <div className="glass-card p-6 space-y-6">
                      <div>
                        <label className="text-sm font-medium text-white mb-2 block">Betting Deadline *</label>
                        <p className="text-2xs text-surface-500 mb-3">After this time, no new bets can be placed.</p>
                        <div className="grid grid-cols-2 gap-3">
                          <input type="date" value={formData.deadlineDate} onChange={(e) => updateForm({ deadlineDate: e.target.value })} min={today} className="input-field" />
                          <input type="time" value={formData.deadlineTime} onChange={(e) => updateForm({ deadlineTime: e.target.value })} className="input-field" />
                        </div>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-white mb-2 block">Resolution Deadline *</label>
                        <p className="text-[10px] text-surface-500 mb-1">Must be resolved by this time. If not, it can be cancelled for refunds.</p>
                        <p className="text-[10px] text-brand-400/80 mb-3">Must be at least 6 hours after betting deadline (3h voting + 3h dispute)</p>
                        <div className="grid grid-cols-2 gap-3">
                          <input type="date" value={formData.resolutionDeadlineDate} onChange={(e) => updateForm({ resolutionDeadlineDate: e.target.value })} min={minResDate} className="input-field" />
                          <input type="time" value={formData.resolutionDeadlineTime} onChange={(e) => updateForm({ resolutionDeadlineTime: e.target.value })} className="input-field" />
                        </div>
                        {formData.deadlineDate && formData.resolutionDeadlineDate && (() => {
                          const dl = new Date(`${formData.deadlineDate}T${formData.deadlineTime}`)
                          const rd = new Date(`${formData.resolutionDeadlineDate}T${formData.resolutionDeadlineTime}`)
                          const diffMs = rd.getTime() - dl.getTime()
                          const minMs = 6 * 60 * 60 * 1000
                          if (diffMs > 0 && diffMs < minMs) {
                            const minTime = new Date(dl.getTime() + minMs)
                            const minTimeStr = minTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            const minDateStr = minTime.toLocaleDateString([], { month: 'short', day: 'numeric' })
                            return <p className="text-xs text-no-400 mt-2">Too close — resolution must be after {minDateStr} {minTimeStr} (6h after betting deadline)</p>
                          }
                          if (diffMs > 0 && diffMs >= minMs) {
                            const hours = Math.floor(diffMs / (60 * 60 * 1000))
                            const mins = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000))
                            return <p className="text-xs text-yes-400/60 mt-2">Duration OK — {hours}h {mins}m after betting deadline</p>
                          }
                          return null
                        })()}
                      </div>
                      <div>
                        <label className="text-sm font-medium text-white mb-2 block">Initial Liquidity ({formData.tokenType}) *</label>
                        <div className="relative">
                          <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
                          <input type="number" value={formData.initialLiquidity} onChange={(e) => updateForm({ initialLiquidity: e.target.value })} placeholder="0.01" min="0.01" step="0.01" className="input-field pl-10 text-lg font-semibold" />
                        </div>
                        <p className="text-2xs text-surface-500 mt-2">
                          Seeds the AMM pool. Split equally across outcomes.
                          {formData.tokenType === 'ETH'
                            ? ' Uses public ETH balance; private credits cannot be used here.'
                            : ` Uses public ${formData.tokenType} balance, plus 1.5 public ETH for the network fee.`}
                        </p>
                      </div>
                      {deadline && resolutionDeadline && (
                        <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.04] space-y-3">
                          <h4 className="text-sm font-medium text-white">Timeline Preview</h4>
                          {[
                            { color: 'bg-yes-400', label: 'Betting Open', range: `Now → ${deadline.toLocaleDateString()}` },
                            { color: 'bg-brand-400', label: 'Awaiting Resolution', range: `${deadline.toLocaleDateString()} → ${resolutionDeadline.toLocaleDateString()}` },
                            { color: 'bg-surface-400', label: 'Resolved & Payouts', range: 'After resolution' },
                          ].map((t) => (
                            <div key={t.label} className="flex items-center gap-3">
                              <div className={cn('w-3 h-3 rounded-full', t.color)} />
                              <div><p className="text-sm text-white">{t.label}</p><p className="text-xs text-surface-500">{t.range}</p></div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}

                {step === 'review' && (
                  <motion.div key="s3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.3 }}>
                    <div className="glass-card p-6 space-y-6">
                      <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.04] space-y-4">
                        {[
                          { label: 'Question', value: formData.question },
                          { label: 'Category', value: `${selectedCategory?.emoji} ${selectedCategory?.name}` },
                          { label: 'Outcomes', value: formData.outcomeLabels.slice(0, formData.numOutcomes).join(', ') },
                          { label: 'Token', value: formData.tokenType },
                          { label: 'Liquidity', value: `${formData.initialLiquidity} ${formData.tokenType}` },
                          { label: 'Betting Ends', value: deadline?.toLocaleString() || 'Not set' },
                          { label: 'Resolution', value: resolutionDeadline?.toLocaleString() || 'Not set' },
                          { label: 'Oracle', value: formData.resolutionSource || 'Not specified' },
                          { label: 'Creator', value: `${wallet.address?.slice(0, 12)}...${wallet.address?.slice(-6)}` },
                        ].map((item) => (
                          <div key={item.label} className="flex items-start justify-between gap-4">
                            <span className="text-xs text-surface-500 flex-shrink-0">{item.label}</span>
                            <span className="text-xs font-medium text-white text-right">{item.value}</span>
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-brand-400/[0.04] border border-brand-400/[0.08]">
                        <Coins className="w-4 h-4 text-brand-400 flex-shrink-0" />
                        <p className="text-xs text-surface-300">As creator, you earn <strong className="text-brand-400">0.5%</strong> of all trading volume. Total fee: 2% per trade.</p>
                      </div>
                    </div>
                  </motion.div>
                )}

                {step === 'creating' && (
                  <motion.div key="creating" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass-card p-12 text-center">
                    <Loader2 className="w-12 h-12 text-brand-400 animate-spin mx-auto mb-4" />
                    <h3 className="text-xl font-display font-bold text-white mb-2">Creating Market...</h3>
                    <p className="text-surface-400">Please confirm the transaction in your wallet.</p>
                    {isSlowTransaction && (
                      <div className="mt-4 p-3 rounded-lg bg-brand-400/[0.06] border border-brand-400/[0.1]">
                        <p className="text-sm text-brand-300">
                          Processing your transaction. This can take 30-60 seconds.
                        </p>
                      </div>
                    )}
                  </motion.div>
                )}

                {step === 'success' && (
                  <motion.div key="success" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="glass-card p-12 text-center">
                    <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', delay: 0.2 }}
                      className="w-20 h-20 rounded-full bg-yes-400/[0.1] mx-auto mb-6 flex items-center justify-center shadow-glow-yes">
                      <Check className="w-10 h-10 text-yes-400" />
                    </motion.div>
                    <h3 className="text-2xl font-display font-bold text-white mb-2">Transaction Submitted!</h3>
                    <p className="text-surface-400 mb-6">Your market creation transaction has been sent to the network.</p>
                    <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.04] mb-4 text-left space-y-3">
                      <div>
                        <p className="text-2xs text-surface-500 uppercase tracking-wider mb-1">Market ID</p>
                        <p className="text-sm text-white font-mono break-all">{marketId}</p>
                      </div>
                      {txHash && (
                        <div>
                          <p className="text-2xs text-surface-500 uppercase tracking-wider mb-1">Transaction Hash</p>
                          <p className="text-sm text-white font-mono break-all">{txHash}</p>
                          <a href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 mt-2">
                            View on Etherscan <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      )}
                    </div>
                    <div className="p-4 rounded-xl bg-brand-400/[0.06] border border-brand-400/[0.1] mb-6 text-left flex items-start gap-3">
                      <Loader2 className="w-5 h-5 text-brand-400 flex-shrink-0 mt-0.5 animate-spin" />
                      <div>
                        <p className="text-sm font-medium text-brand-300">Waiting for on-chain confirmation...</p>
                        <p className="text-xs text-surface-400 mt-1">This can take 1-3 minutes. You can navigate away — the process continues in the background.</p>
                      </div>
                    </div>
                    <button onClick={() => navigate('/dashboard')} className="btn-primary w-full">Back to Markets</button>
                  </motion.div>
                )}

                {step === 'error' && (
                  <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass-card p-12 text-center">
                    <div className="w-16 h-16 rounded-full bg-no-400/[0.1] flex items-center justify-center mx-auto mb-4">
                      <AlertCircle className="w-8 h-8 text-no-400" />
                    </div>
                    <h3 className="text-xl font-display font-bold text-white mb-2">Creation Failed</h3>
                    <p className="text-surface-400 mb-6 text-sm">{error}</p>
                    <div className="flex gap-3">
                      <button onClick={() => { setStep('review'); setIsSubmitting(false) }} className="flex-1 btn-secondary">Go Back</button>
                      <button onClick={handleCreate} className="flex-1 btn-primary">Try Again</button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Navigation buttons */}
              {(step === 'details' || step === 'timing' || step === 'review') && (
                <div className="flex items-center justify-between mt-8">
                  <button onClick={step === 'details' ? () => navigate('/dashboard') : handleBack} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-surface-400 hover:text-white hover:bg-white/[0.04] transition-all">
                    <ArrowLeft className="w-4 h-4" />{step === 'details' ? 'Cancel' : 'Back'}
                  </button>
                  {error && <p className="text-no-400 text-xs max-w-sm text-center">{error}</p>}
                  {step !== 'review' ? (
                    <button onClick={handleNext} className="btn-primary flex items-center gap-2">Continue <ArrowRight className="w-4 h-4" /></button>
                  ) : (
                    <button onClick={handleCreate} disabled={isSubmitting} className="btn-primary flex items-center gap-2 disabled:opacity-50">
                      <Shield className="w-4 h-4" />Create Market
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Side Panel — Tips */}
            <div className="lg:col-span-5 xl:col-span-4 lg:mt-[168px]">
              <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="sticky top-24 space-y-4">
                <div className="glass-card p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <Lightbulb className="w-4 h-4 text-brand-400" />
                    <h3 className="text-sm font-semibold text-white">Tips</h3>
                  </div>
                  <ul className="space-y-3">
                    {[
                      'Write clear, unambiguous questions that can be definitively resolved',
                      'Set realistic deadlines — allow enough time for events to unfold',
                      'Use reliable resolution sources (official APIs, verifiable data)',
                      'Higher initial liquidity attracts more traders and tighter spreads',
                      'Include detailed description to prevent disputes',
                    ].map((tip, i) => (
                      <li key={i} className="flex items-start gap-2.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-yes-400 mt-0.5 flex-shrink-0" />
                        <span className="text-xs text-surface-300 leading-relaxed">{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="glass-card p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <AlertTriangle className="w-4 h-4 text-brand-400" />
                    <h3 className="text-sm font-semibold text-white">Important</h3>
                  </div>
                  <ul className="space-y-3">
                    {[
                      'Market creators earn 0.5% of all trading volume',
                      'Initial liquidity seeds the AMM pool and cannot be withdrawn until resolution',
                      'Markets use FHE encryption for private balances (may take 30-60 seconds)',
                      'Disputes are resolved by the community governance process',
                    ].map((note, i) => (
                      <li key={i} className="flex items-start gap-2.5">
                        <span className="w-1 h-1 rounded-full bg-brand-400 mt-2 flex-shrink-0" />
                        <span className="text-xs text-surface-400 leading-relaxed">{note}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="glass-card p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <Shield className="w-4 h-4 text-brand-400" />
                    <h3 className="text-sm font-semibold text-white">Privacy</h3>
                  </div>
                  <p className="text-xs text-surface-400 leading-relaxed">
                    Market creation is processed with Fully Homomorphic Encryption on the Fhenix network. 
                    Your identity as creator is encrypted on-chain.
                  </p>
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  )
}
