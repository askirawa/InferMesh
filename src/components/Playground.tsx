import { useEffect, useRef, useState } from 'react'
import {
  Send, AlertCircle, Loader2, ChevronDown, CheckCircle,
  Clock, Zap, Hash, Info, X, Gauge, ShieldCheck, ShieldOff,
} from 'lucide-react'
import { api, OrbioModel, QuotaInfo } from '../lib/api'
import { formatLatency, formatTokens, modelDisplayName, modelProvider, getModelPricing } from '../lib/utils'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { useAuth } from '../lib/auth'

interface Message {
  role: 'user' | 'assistant'
  content: string
  meta?: {
    latency_ms?: number
    input_tokens?: number | null
    output_tokens?: number | null
    balance_after?: string | null
    quota?: QuotaInfo
  }
}

interface Props {
  initialModel?: string
}

export default function Playground({ initialModel }: Props) {
  const { address } = useAccount()
  const { authState, getAuthHeaders, invalidate, isAuthenticating } = useAuth()

  const [models, setModels] = useState<OrbioModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState(initialModel ?? '')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendErrorCode, setSendErrorCode] = useState<string | null>(null)
  const [serverStatus, setServerStatus] = useState<{ ok: boolean; hasApiKey: boolean } | null>(null)
  const [quota, setQuota] = useState<QuotaInfo | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    api.health().then((s) => { if (!cancelled) setServerStatus(s) }).catch(() => null)
    api.models()
      .then((res) => {
        if (cancelled) return
        const list = res.data ?? []
        setModels(list)
        setModelsLoading(false)
        setSelectedModel((prev) => {
          if (prev) return prev
          const preferred = ['anthropic/claude-sonnet-5', 'openai/gpt-4o', 'google/gemini-3.8-flash']
          const found = preferred.find((id) => list.some((m) => m.id === id))
          return found ?? (list[0]?.id ?? '')
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) { setModelsError(String(e)); setModelsLoading(false) }
      })
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch quota when auth state transitions to 'signed'
  useEffect(() => {
    if (!address || authState.status !== 'signed') {
      if (!address) setQuota(null)
      return
    }
    let cancelled = false
    getAuthHeaders()
      .then((headers) => api.quota(headers))
      .then((q) => { if (!cancelled) setQuota(q) })
      .catch(() => null)
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, authState.status])

  // Sync when parent passes a new initialModel (e.g. from Marketplace "Use in Playground")
  useEffect(() => {
    if (initialModel) setSelectedModel(initialModel)
  // Only re-run when initialModel identity changes — parent-driven prop update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialModel])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const selectedModelObj = models.find((m) => m.id === selectedModel)
  const selectedModelIsRouter = selectedModelObj
    ? (() => {
        const p = getModelPricing(selectedModelObj.pricing)
        return p.input.status === 'invalid' || p.output.status === 'invalid'
      })()
    : false

  const filteredModels = modelSearch
    ? models.filter((m) => m.id.toLowerCase().includes(modelSearch.toLowerCase()))
    : models

  function cleanError(raw: unknown): string {
    const s = String(raw)
    return s.startsWith('Error: ') ? s.slice(7) : s
  }

  async function handleSend() {
    const content = input.trim()
    if (!content || sending || !selectedModel) return
    if (!address) return

    setSending(true)
    setSendError(null)
    setSendErrorCode(null)
    setInput('')

    const userMsg: Message = { role: 'user', content }
    setMessages((prev) => [...prev, userMsg])

    // Helper to attempt the request, optionally with a fresh nonce after a 401.
    const attempt = async (isRetry = false): Promise<void> => {
      let authHeaders
      try {
        authHeaders = await getAuthHeaders()
      } catch (e: unknown) {
        const msg = cleanError(e)
        setSendError(msg)
        setSendErrorCode('auth_error')
        return
      }

      try {
        const res = await api.chat({
          model: selectedModel,
          messages: [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })),
        }, authHeaders)

        // Update quota meter from response
        if (res.quota) setQuota(res.quota)

        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: res.response,
            meta: {
              latency_ms: res.latency_ms,
              input_tokens: res.usage.input_tokens,
              output_tokens: res.usage.output_tokens,
              balance_after: res.balance_after,
              quota: res.quota,
            },
          },
        ])
      } catch (e: unknown) {
        const err = e as Error & { status?: number; code?: string }
        const msg = cleanError(e)

        // On 401 (expired/replayed nonce), invalidate and retry once.
        // invalidate() kicks off a nonce fetch immediately; getAuthHeaders()
        // in the retry will await that fetch via nonceFetchRef, so no fixed
        // sleep is needed — the retry proceeds as soon as the nonce arrives.
        if (err.status === 401 && !isRetry) {
          invalidate()
          return attempt(true)
        }

        setSendError(msg)

        if (err.status === 401 || err.code === 'missing_headers' || err.code === 'invalid_nonce'
            || err.code === 'signature_mismatch') {
          setSendErrorCode('auth_error')
        } else if (msg.includes('quota_exceeded') || msg.includes('free daily')) {
          setSendErrorCode('quota_exceeded')
        } else if (msg.includes('rate_limited') || msg.includes('too quickly')) {
          setSendErrorCode('rate_limited')
        } else if (msg.includes('wallet_required')) {
          setSendErrorCode('wallet_required')
        } else {
          setSendErrorCode('error')
        }
      }
    }

    try {
      await attempt()
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  function clearConversation() {
    setMessages([])
    setSendError(null)
    setSendErrorCode(null)
  }

  const quotaPct = quota
    ? Math.min(100, Math.round((quota.used_requests / quota.limit_requests) * 100))
    : 0
  const quotaExhausted = quota ? quota.used_requests >= quota.limit_requests : false
  const resetsIn = quota
    ? Math.max(0, Math.ceil((quota.resets_at - Date.now()) / 3_600_000))
    : null

  const canSend = !!address && !!input.trim() && !sending && !isAuthenticating && !!selectedModel
    && (serverStatus === null || serverStatus.hasApiKey)
    && !quotaExhausted

  // Human-readable auth status label
  const authStatusLabel = (() => {
    if (!address) return null
    switch (authState.status) {
      case 'fetching_nonce': return 'Getting nonce…'
      case 'signing':        return 'Awaiting signature…'
      case 'signed':         return 'Verified'
      case 'error':          return 'Auth error'
      default:               return null
    }
  })()

  const authVerified = authState.status === 'signed'

  return (
    <div className="flex flex-col h-[calc(100dvh-56px)] lg:h-dvh max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="display text-2xl font-semibold text-[var(--ink)] tracking-tight">Playground</h1>
          <p className="text-sm text-[var(--muted)] mt-0.5">Test models with real inference</p>
        </div>
        <div className="flex items-center gap-3 shrink-0 mt-1">
          {/* Auth status chip */}
          {address && authStatusLabel && (
            <div className={`flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded-full
              ${authVerified
                ? 'bg-[var(--surface-strong)] text-[var(--sage)]'
                : authState.status === 'error'
                  ? 'bg-red-500/10 text-red-400'
                  : 'bg-[var(--surface)] text-[var(--muted)]'}`}
            >
              {authVerified
                ? <ShieldCheck size={11} />
                : authState.status === 'error'
                  ? <ShieldOff size={11} />
                  : <Loader2 size={11} className="animate-spin" />}
              {authStatusLabel}
            </div>
          )}
          {messages.length > 0 && (
            <button
              onClick={clearConversation}
              className="text-xs text-[var(--subtle)] hover:text-[var(--ink)] flex items-center gap-1.5"
            >
              <X size={13} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Wallet required */}
      {!address && (
        <div className="flex items-start gap-3 px-4 py-4 rounded-xl bg-[var(--surface)] border border-[var(--border)]">
          <Info size={15} className="text-[var(--subtle)] mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-[var(--ink)] font-medium">Wallet required</p>
            <p className="text-xs text-[var(--muted)] mt-0.5 mb-3">
              Connect a wallet to use the free inference allowance. No transaction is needed.
            </p>
            <ConnectKitButton />
          </div>
        </div>
      )}

      {/* Auth error */}
      {address && authState.status === 'error' && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
          <ShieldOff size={15} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-red-300 font-medium">Authentication error</p>
            <p className="text-xs text-red-400/80 mt-0.5">{authState.message}</p>
          </div>
        </div>
      )}

      {/* Signing prompt */}
      {address && authState.status === 'signing' && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-[var(--surface-strong)] border border-[var(--border)]">
          <ShieldCheck size={15} className="text-[var(--sage)] mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-[var(--ink-2)] font-medium">Approve in your wallet</p>
            <p className="text-xs text-[var(--sage)]/80 mt-0.5">
              Please sign the authentication message in your wallet. This verifies ownership —
              no gas fee, no transaction.
            </p>
          </div>
        </div>
      )}

      {/* API key warning */}
      {serverStatus && !serverStatus.hasApiKey && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <Info size={15} className="text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-amber-300 font-medium">API key required</p>
            <p className="text-xs text-amber-400/80 mt-0.5">
              Add <code className="mono bg-amber-500/10 px-1 rounded">ORBIO_API_KEY=sk-orbio-...</code> to
              your <code className="mono bg-amber-500/10 px-1 rounded">.env</code> file and restart the server.
              Get a key at <a href="https://orbio.so" target="_blank" rel="noopener"
                className="underline hover:text-amber-300">orbio.so</a>.
            </p>
          </div>
        </div>
      )}

      {/* Quota exhausted banner */}
      {quotaExhausted && address && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
          <AlertCircle size={15} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-red-300 font-medium">Free daily allowance exhausted</p>
            <p className="text-xs text-red-400/80 mt-0.5">
              You have used all {quota?.limit_requests} free requests today.
              Quota resets in ~{resetsIn}h at UTC midnight.
              USDC payment to top up credits is coming in Phase 2.
            </p>
          </div>
        </div>
      )}

      {/* Router/alias model warning */}
      {selectedModelIsRouter && !modelsLoading && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-[var(--surface)] border border-[var(--border)]">
          <Info size={15} className="text-[var(--subtle)] mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-[var(--muted)] font-medium">Dynamic-routing model</p>
            <p className="text-xs text-[var(--subtle)] mt-0.5">
              <span className="mono text-[var(--ink)]">{selectedModel}</span> is a routing alias whose
              per-request cost is determined at inference time. Orbio does not report a fixed price for it.
            </p>
          </div>
        </div>
      )}

      {/* Quota meter */}
      {address && quota && !quotaExhausted && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-[var(--surface)] border border-[var(--border)]">
          <Gauge size={13} className="text-[var(--subtle)] shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-[var(--subtle)]">Free allowance</span>
              <span className="text-[10px] text-[var(--muted)] tabular-nums">
                {quota.used_requests}/{quota.limit_requests} req
                {' · '}
                {quota.used_tokens.toLocaleString()}/{quota.limit_tokens.toLocaleString()} tok
              </span>
            </div>
            <div className="h-1 rounded-full bg-[var(--surface-muted)] overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${quotaPct}%`, background: quotaPct >= 90 ? '#c9a04a' : 'var(--sage)' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Model picker */}
      <div className="relative">
        <button
          onClick={() => setModelPickerOpen(!modelPickerOpen)}
          disabled={modelsLoading}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--border)]
            bg-[var(--surface)] hover:bg-[var(--surface-strong)] transition-colors text-left
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="flex-1 min-w-0">
            {modelsLoading ? (
              <span className="text-sm text-[var(--muted)]">Loading models...</span>
            ) : modelsError ? (
              <span className="text-sm text-red-400">Failed to load models</span>
            ) : selectedModelObj ? (
              <>
                <p className="text-sm font-medium text-[var(--ink)] truncate">
                  {modelDisplayName(selectedModelObj)}
                </p>
                <p className="text-xs text-[var(--subtle)]">
                  {modelProvider(selectedModelObj)}
                  {selectedModelObj.context_length
                    ? ` · ${(selectedModelObj.context_length / 1000).toFixed(0)}k ctx`
                    : ''}
                </p>
              </>
            ) : (
              <span className="text-sm text-[var(--muted)]">Select a model</span>
            )}
          </div>
          {modelsLoading ? (
            <Loader2 size={14} className="animate-spin text-[var(--subtle)]" />
          ) : (
            <ChevronDown size={14} className={`text-[var(--subtle)] transition-transform ${modelPickerOpen ? 'rotate-180' : ''}`} />
          )}
        </button>

        {modelPickerOpen && models.length > 0 && (
          <div className="absolute top-full left-0 right-0 z-30 mt-1 border border-[var(--border)]
            rounded-xl bg-[var(--surface-muted)] shadow-xl overflow-hidden">
            <div className="p-2 border-b border-[var(--border)]">
              <input
                autoFocus
                placeholder="Search models..."
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                className="w-full px-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg
                  text-sm text-[var(--ink)] placeholder:text-[var(--subtle)]
                  focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
              />
            </div>
            <div className="max-h-56 overflow-y-auto">
              {filteredModels.slice(0, 100).map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setSelectedModel(m.id)
                    setModelPickerOpen(false)
                    setModelSearch('')
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--surface-strong)]
                    transition-colors text-sm
                    ${m.id === selectedModel ? 'bg-[var(--surface-strong)]' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-[var(--ink)] truncate text-sm">{modelDisplayName(m)}</p>
                    <p className="text-xs text-[var(--subtle)]">{modelProvider(m)}</p>
                  </div>
                  {m.id === selectedModel && <CheckCircle size={13} className="text-[var(--sage)] shrink-0" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto border border-[var(--border)] rounded-xl bg-[var(--surface)] min-h-0">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full py-12 text-center px-4">
            <Zap size={28} className="text-[var(--sage)] mb-3" />
            <p className="text-sm font-medium text-[var(--ink)]">Ready for inference</p>
            <p className="text-xs text-[var(--subtle)] mt-1 max-w-xs">
              {address
                ? 'Select a model above and type a prompt.'
                : 'Connect your wallet to start. No transaction required.'}
            </p>
          </div>
        )}

        <div className="px-4 py-4 space-y-5">
          {messages.map((msg, i) => (
            <div key={i} className={`flex flex-col gap-1.5 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed
                ${msg.role === 'user'
                  ? 'bg-[var(--surface-strong)] text-[var(--ink)] border border-[var(--border)]'
                  : 'bg-[var(--surface-strong)] text-[var(--ink)] border border-[var(--border)]'
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
              {msg.meta && (
                <div className="flex items-center flex-wrap gap-3 text-[10px] text-[var(--subtle)] px-1">
                  {msg.meta.latency_ms != null && (
                    <span className="flex items-center gap-1 tabular-nums">
                      <Clock size={10} /> {formatLatency(msg.meta.latency_ms)}
                    </span>
                  )}
                  {(msg.meta.input_tokens != null || msg.meta.output_tokens != null) && (
                    <span className="flex items-center gap-1 tabular-nums">
                      <Hash size={10} />
                      {formatTokens(msg.meta.input_tokens ?? null)}
                      {' / '}
                      {formatTokens(msg.meta.output_tokens ?? null)}
                      {' tokens'}
                    </span>
                  )}
                  {msg.meta.balance_after && (
                    <span className="tabular-nums">
                      ${parseFloat(msg.meta.balance_after).toFixed(4)} balance
                    </span>
                  )}
                  {msg.meta.quota && (
                    <span className="tabular-nums text-[var(--subtle)]/70">
                      {msg.meta.quota.used_requests}/{msg.meta.quota.limit_requests} req used today
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}

          {sending && (
            <div className="flex items-start gap-2">
              <div className="px-4 py-3 rounded-2xl bg-[var(--surface-strong)] border border-[var(--border)]
                flex items-center gap-2">
                <Loader2 size={13} className="animate-spin text-[var(--muted)]" />
                <span className="text-sm text-[var(--muted)]">
                  {isAuthenticating ? 'Authenticating…' : 'Generating…'}
                </span>
              </div>
            </div>
          )}

          {sendError && (
            <div className={`flex items-start gap-2 px-1 py-3 rounded-xl border mx-0
              ${sendErrorCode === 'quota_exceeded'
                ? 'bg-red-500/10 border-red-500/20'
                : sendErrorCode === 'rate_limited'
                  ? 'bg-amber-500/10 border-amber-500/20'
                  : sendErrorCode === 'auth_error'
                    ? 'bg-orange-500/10 border-orange-500/20'
                    : 'bg-[var(--surface)] border-[var(--border)]'
              }`}
            >
              <AlertCircle size={14} className={`mt-0.5 shrink-0
                ${sendErrorCode === 'quota_exceeded' ? 'text-red-400'
                  : sendErrorCode === 'rate_limited' ? 'text-amber-400'
                  : sendErrorCode === 'auth_error' ? 'text-orange-400'
                  : 'text-red-400'}`}
              />
              <div>
                <p className={`text-sm font-medium
                  ${sendErrorCode === 'quota_exceeded' ? 'text-red-300'
                    : sendErrorCode === 'rate_limited' ? 'text-amber-300'
                    : sendErrorCode === 'auth_error' ? 'text-orange-300'
                    : 'text-red-400'}`}
                >
                  {sendErrorCode === 'quota_exceeded' && 'Free allowance exhausted'}
                  {sendErrorCode === 'rate_limited' && 'Rate limited'}
                  {sendErrorCode === 'wallet_required' && 'Wallet required'}
                  {sendErrorCode === 'auth_error' && 'Authentication failed'}
                  {sendErrorCode === 'error' && 'Request failed'}
                  {!sendErrorCode && 'Error'}
                </p>
                <p className="text-xs text-[var(--muted)] mt-0.5">{sendError}</p>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className={`relative border rounded-xl bg-[var(--surface)] transition-all
        ${canSend ? 'focus-within:ring-1 focus-within:ring-[var(--border-strong)] focus-within:border-[var(--border-strong)]' : ''}
        border-[var(--border)]`}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !address ? 'Connect your wallet to use the Playground...'
            : isAuthenticating ? 'Authenticating your wallet…'
            : quotaExhausted ? 'Free allowance exhausted — USDC payments coming in Phase 2...'
            : sending ? 'Waiting for response...'
            : 'Type a prompt... (Enter to send, Shift+Enter for newline)'
          }
          disabled={sending || !selectedModel || !address || quotaExhausted}
          rows={3}
          className="w-full px-4 pt-3 pb-12 bg-transparent text-sm text-[var(--ink)]
            placeholder:text-[var(--subtle)] resize-none
            focus:outline-none disabled:opacity-50"
        />
        <div className="absolute bottom-3 right-3 flex items-center gap-2">
          <button
            onClick={() => void handleSend()}
            disabled={!canSend}
            className="btn-primary rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
