import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Activity, Cpu, Clock, AlertCircle, ArrowRight,
  CheckCircle, XCircle, Zap, TrendingUp, Gauge,
  ShieldCheck, ShieldOff, Loader2, RefreshCw,
} from 'lucide-react'
import { api, UsageStats, QuotaStatus } from '../lib/api'
import { formatRelativeTime, formatLatency, formatTokens } from '../lib/utils'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { useAuth } from '../lib/auth'
import { requireChain } from '@/onchain-facts'

const ARC_MAINNET_ID = 5042

interface Props {
  onNavigate: (p: 'marketplace' | 'playground' | 'usage' | 'wallet') => void
}

// ── Quota section ────────────────────────────────────────────────────────────

type QuotaLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: QuotaStatus; fetchedAt: number }
  | { status: 'error'; message: string }

function QuotaSection({
  authState,
  getAuthHeaders,
  invalidate,
  onNavigate,
}: {
  authState: ReturnType<typeof useAuth>['authState']
  getAuthHeaders: ReturnType<typeof useAuth>['getAuthHeaders']
  invalidate: ReturnType<typeof useAuth>['invalidate']
  onNavigate: Props['onNavigate']
}) {
  const [quota, setQuota] = useState<QuotaLoadState>({ status: 'idle' })

  // Monotonically increasing counter — each wallet change or manual refresh
  // increments this; only the fetch that holds the current value may commit.
  // This prevents a stale fetch from a previous wallet overwriting current data.
  const fetchGenRef = useRef(0)

  const fetchQuota = useCallback(async (retry = false): Promise<void> => {
    const gen = fetchGenRef.current
    setQuota({ status: 'loading' })
    try {
      const headers = await getAuthHeaders()
      // Re-check generation after the async getAuthHeaders call — wallet may
      // have changed while we were waiting for the nonce or signature.
      if (fetchGenRef.current !== gen) return
      const data = await api.quota(headers)
      if (fetchGenRef.current !== gen) return
      setQuota({ status: 'ok', data, fetchedAt: Date.now() })
    } catch (e: unknown) {
      if (fetchGenRef.current !== gen) return
      const err = e as Error & { status?: number }
      if (err.status === 401 && !retry) {
        invalidate()
        return fetchQuota(true)
      }
      setQuota({ status: 'error', message: String(e) })
    }
  }, [getAuthHeaders, invalidate])

  // Fetch quota when auth state reaches ready or signed.
  // Increment the generation counter on every trigger so any in-flight fetch
  // from a previous wallet or auth state is silently discarded on resolve.
  useEffect(() => {
    if (authState.status === 'signed' || authState.status === 'ready') {
      fetchGenRef.current += 1
      void fetchQuota()
    } else if (authState.status === 'disconnected') {
      fetchGenRef.current += 1
      setQuota({ status: 'idle' })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState.status])

  // ── Auth still in progress ──
  if (authState.status === 'fetching_nonce' || authState.status === 'signing' || quota.status === 'loading') {
    return (
      <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Gauge size={13} className="text-[var(--subtle)]" />
          <span className="text-[11px] text-[var(--subtle)] uppercase tracking-wider font-medium">
            Free Tier Quota
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <Loader2 size={13} className="animate-spin shrink-0" />
          <span>
            {authState.status === 'fetching_nonce' ? 'Fetching auth nonce…' :
             authState.status === 'signing' ? 'Awaiting wallet signature…' :
             'Loading quota…'}
          </span>
        </div>
      </div>
    )
  }

  // ── Auth error ──
  if (authState.status === 'error') {
    return (
      <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5 mb-6">
        <div className="flex items-start gap-2">
          <ShieldOff size={14} className="text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-300 font-medium">Authentication error</p>
            <p className="text-xs text-red-400/80 mt-0.5">{authState.message}</p>
            <p className="text-xs text-[var(--subtle)] mt-1">
              Quota information requires a valid wallet signature.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ── Quota fetch error ──
  if (quota.status === 'error') {
    return (
      <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Gauge size={13} className="text-[var(--subtle)]" />
            <span className="text-[11px] text-[var(--subtle)] uppercase tracking-wider font-medium">
              Free Tier Quota
            </span>
          </div>
          <button
            onClick={() => { fetchGenRef.current += 1; void fetchQuota() }}
            className="text-xs text-[var(--subtle)] hover:text-[var(--ink)] flex items-center gap-1 transition-colors"
          >
            <RefreshCw size={11} /> Retry
          </button>
        </div>
        <div className="flex items-start gap-2">
          <AlertCircle size={13} className="text-[var(--muted)] shrink-0 mt-0.5" />
          <p className="text-xs text-[var(--muted)]">
            Quota information is temporarily unavailable.
          </p>
        </div>
      </div>
    )
  }

  // ── Quota idle ──
  if (quota.status !== 'ok') return null

  // ── Quota loaded ── (TS now knows quota is { status: 'ok', data: QuotaStatus })
  const q = quota.data
  const usedReq = q.used_requests
  const limitReq = q.limit_requests
  const pct = limitReq > 0 ? Math.min(100, Math.round((usedReq / limitReq) * 100)) : 0
  const remaining = Math.max(0, limitReq - usedReq)
  const exhausted = remaining === 0
  const warning = pct >= 80 && !exhausted

  const resetsAtMs = q.resets_at
  const resetsIn = resetsAtMs > Date.now()
    ? Math.ceil((resetsAtMs - Date.now()) / 3_600_000)
    : null
  const resetLabel = resetsIn != null
    ? resetsIn <= 1 ? 'Resets in < 1h' : `Resets in ~${resetsIn}h`
    : 'Resets at UTC midnight'

  const usedTok = q.used_tokens
  const limitTok = q.limit_tokens
  const tokPct = limitTok > 0 ? Math.min(100, Math.round((usedTok / limitTok) * 100)) : 0

  const barColor = exhausted ? 'bg-red-500' : warning ? 'bg-amber-500' : 'bg-emerald-500'

  return (
    <div className={`p-4 rounded-xl border mb-6 ${
      exhausted
        ? 'border-red-500/25 bg-red-500/5'
        : warning
          ? 'border-amber-500/20 bg-amber-500/5'
          : 'border-[var(--border)] bg-[var(--surface)]'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Gauge size={13} className={exhausted ? 'text-red-400' : warning ? 'text-amber-400' : 'text-[var(--subtle)]'} />
          <span className="text-[11px] text-[var(--subtle)] uppercase tracking-wider font-medium">
            Free Tier Quota
          </span>
          {q.global_circuit_breaker_tripped && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20">
              Service limited
            </span>
          )}
        </div>
        <button
          onClick={() => { fetchGenRef.current += 1; void fetchQuota() }}
          className="text-[var(--subtle)] hover:text-[var(--ink)] transition-colors p-1 rounded hover:bg-[var(--surface-strong)]"
          aria-label="Refresh quota"
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {/* Requests */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-[var(--muted)]">Requests</span>
          <span className={`text-xs tabular-nums font-medium ${
            exhausted ? 'text-red-400' : warning ? 'text-amber-400' : 'text-[var(--ink)]'
          }`}>
            {usedReq.toLocaleString()} / {limitReq.toLocaleString()}
          </span>
        </div>
        <div
          className="h-1.5 rounded-full bg-[var(--surface-muted)] overflow-hidden"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pct}% of daily request quota used`}
        >
          <div
            className={`h-full rounded-full transition-all duration-300 ${barColor}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Tokens */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-[var(--muted)]">Tokens</span>
          <span className="text-xs tabular-nums text-[var(--subtle)]">
            {usedTok.toLocaleString()} / {limitTok.toLocaleString()}
          </span>
        </div>
        <div className="h-1 rounded-full bg-[var(--surface-muted)] overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${barColor} opacity-70`}
            style={{ width: `${tokPct}%` }}
          />
        </div>
      </div>

      {/* Status row */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--border)]">
        <div>
          {exhausted ? (
            <p className="text-xs text-red-400 font-medium">
              Daily allowance exhausted — {resetLabel}
            </p>
          ) : (
            <p className={`text-xs ${warning ? 'text-amber-400' : 'text-[var(--muted)]'}`}>
              {remaining.toLocaleString()} request{remaining !== 1 ? 's' : ''} remaining — {resetLabel}
            </p>
          )}
          {q.global_circuit_breaker_tripped && q.global_reason && (
            <p className="text-[11px] text-red-400/70 mt-0.5">{q.global_reason}</p>
          )}
        </div>
        {exhausted && (
          <button
            onClick={() => onNavigate('playground')}
            className="text-xs text-[var(--subtle)] hover:text-[var(--muted)] transition-colors flex items-center gap-1"
          >
            Playground <ArrowRight size={10} />
          </button>
        )}
      </div>

      {exhausted && (
        <div className="mt-3 px-3 py-2.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)]">
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Your free tier renews at UTC midnight. USDC-based top-ups will be available in a future update.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export default function Dashboard({ onNavigate }: Props) {
  const { address, chainId, isConnected } = useAccount()
  const { authState, getAuthHeaders, invalidate } = useAuth()
  const arcChain = requireChain(ARC_MAINNET_ID)
  const isOnArc = chainId === ARC_MAINNET_ID

  // Use a single state object so we never call setState synchronously inside an effect.
  // The initial `loading: true` state avoids a flash before the first fetch completes.
  const [statsState, setStatsState] = useState<
    | { loading: true; data: null; error: null }
    | { loading: false; data: UsageStats; error: null }
    | { loading: false; data: null; error: string }
  >({ loading: true, data: null, error: null })

  useEffect(() => {
    let cancelled = false
    // Fetch stats; when the address changes the previous result stays until the new
    // fetch resolves — avoids a synchronous setState reset inside the effect.
    void api.usageStats(address)
      .then((s) => { if (!cancelled) setStatsState({ loading: false, data: s, error: null }) })
      .catch((e: unknown) => {
        if (!cancelled) setStatsState({ loading: false, data: null, error: String(e) })
      })
    return () => { cancelled = true }
  }, [address])

  const statsLoading = statsState.loading
  const stats = statsState.data
  const statsError = statsState.error

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-5xl mx-auto">

      {/* Page title */}
      <div className="mb-6">
        <h1 className="display text-[22px] font-semibold text-[var(--ink)] tracking-tight">
          Dashboard
        </h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          AI inference on Arc Mainnet via the Orbio gateway
        </p>
      </div>

      {/* Wrong-network banner */}
      {isConnected && !isOnArc && (
        <div className="mb-5 flex items-start gap-3 px-4 py-3 rounded-xl
          bg-amber-500/10 border border-amber-500/20">
          <AlertCircle size={15} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-amber-300 font-medium">Wrong network</p>
            <p className="text-xs text-amber-400/80 mt-0.5">
              Switch to {arcChain.name} (chain {ARC_MAINNET_ID}) to enable payments.
              Currently on chain {chainId}.
            </p>
          </div>
        </div>
      )}

      {/* Not connected prompt */}
      {!isConnected && (
        <div className="mb-6 p-5 rounded-xl border border-[var(--border)] bg-[var(--surface)]
          flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-[var(--ink)]">Connect a wallet to get started</p>
            <p className="text-xs text-[var(--muted)] mt-0.5">
              Your wallet address is used for authentication and quota tracking. No gas fee required.
            </p>
          </div>
          <div className="shrink-0">
            <ConnectKitButton />
          </div>
        </div>
      )}

      {/* Connected wallet strip */}
      {isConnected && address && (
        <div className="mb-6 flex items-center gap-3 px-4 py-2.5 rounded-xl
          border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${isOnArc ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span className="mono text-xs text-[var(--muted)] truncate tabular-nums">{address}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {authState.status === 'signed' && (
              <span className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full
                bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <ShieldCheck size={10} /> Verified
              </span>
            )}
            {(authState.status === 'fetching_nonce' || authState.status === 'signing') && (
              <span className="flex items-center gap-1 text-[10px] text-[var(--muted)] px-2 py-0.5 rounded-full
                bg-[var(--surface-strong)] border border-[var(--border)]">
                <Loader2 size={10} className="animate-spin" />
                {authState.status === 'signing' ? 'Signing…' : 'Auth…'}
              </span>
            )}
            {authState.status === 'error' && (
              <span className="flex items-center gap-1 text-[10px] text-red-400 px-2 py-0.5 rounded-full
                bg-red-500/10 border border-red-500/20">
                <ShieldOff size={10} /> Auth error
              </span>
            )}
            <span className="text-xs text-[var(--subtle)]">
              {isOnArc ? arcChain.name : `Chain ${chainId}`}
            </span>
            {isOnArc && <CheckCircle size={13} className="text-emerald-400" />}
          </div>
        </div>
      )}

      {/* Quota section */}
      {isConnected && address && (
        <QuotaSection
          authState={authState}
          getAuthHeaders={getAuthHeaders}
          invalidate={invalidate}
          onNavigate={onNavigate}
        />
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {([
          {
            label: 'Total Requests',
            displayValue: statsLoading ? null : String(stats?.total_requests ?? 0),
            icon: Activity,
            accent: 'text-emerald-400',
          },
          {
            label: 'Total Tokens',
            displayValue: statsLoading ? null : formatTokens(stats?.total_tokens ?? null),
            icon: TrendingUp,
            accent: 'text-sky-400',
          },
          {
            label: 'Avg Latency',
            displayValue: null as string | null,
            icon: Clock,
            accent: 'text-amber-400',
          },
        ]).map(({ label, displayValue, icon: Icon, accent }) => (
          <div key={label} className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="flex items-center gap-2 mb-3">
              <Icon size={14} className={accent} />
              <span className="text-[11px] text-[var(--subtle)] uppercase tracking-wider font-medium">
                {label}
              </span>
            </div>
            <p className="display text-2xl font-semibold text-[var(--ink)] tabular-nums tracking-tight">
              {displayValue != null
                ? displayValue
                : <span className="text-[var(--subtle)] text-xl">—</span>}
            </p>
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <ActionCard
          icon={Cpu}
          iconColor="text-emerald-400"
          title="Explore Models"
          description="Browse 400+ AI models, compare pricing and capabilities"
          cta="View catalogue"
          ctaColor="text-emerald-400"
          onClick={() => onNavigate('marketplace')}
        />
        <ActionCard
          icon={Zap}
          iconColor="text-sky-400"
          title="Run Inference"
          description="Test models with real requests in the playground"
          cta="Open playground"
          ctaColor="text-sky-400"
          onClick={() => onNavigate('playground')}
        />
      </div>

      {/* Recent activity */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold text-[var(--subtle)] uppercase tracking-wider">
            Recent Activity
          </h2>
          {stats && stats.total_requests > 0 && (
            <button
              onClick={() => onNavigate('usage')}
              className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
            >
              View all <ArrowRight size={12} />
            </button>
          )}
        </div>

        {statsError && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertCircle size={14} className="text-red-400 shrink-0" />
            <p className="text-sm text-red-400">{statsError}</p>
          </div>
        )}

        {!statsLoading && !statsError && !stats?.recent?.length && (
          <div className="py-10 text-center border border-dashed border-[var(--border)] rounded-xl">
            <Clock size={22} className="text-[var(--subtle)] mx-auto mb-3" />
            <p className="text-sm text-[var(--muted)]">No inference requests yet</p>
            <p className="text-xs text-[var(--subtle)] mt-1">
              Run your first prompt in the playground
            </p>
            <button
              onClick={() => onNavigate('playground')}
              className="mt-4 px-4 py-2 bg-emerald-500 hover:bg-emerald-600
                text-white text-sm rounded-lg transition-colors font-medium"
            >
              Open Playground
            </button>
          </div>
        )}

        {!statsLoading && stats?.recent && stats.recent.length > 0 && (
          <div className="border border-[var(--border)] rounded-xl overflow-hidden">
            {stats.recent.map((r, i) => (
              <div
                key={r.id}
                className={`flex items-center gap-3 px-4 py-3 ${
                  i < stats.recent.length - 1 ? 'border-b border-[var(--border)]' : ''
                }`}
              >
                {r.status === 'success'
                  ? <CheckCircle size={13} className="text-emerald-400 shrink-0" />
                  : <XCircle size={13} className="text-red-400 shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--ink)] truncate">{r.model_id}</p>
                  <p className="text-xs text-[var(--subtle)]">{formatRelativeTime(r.created_at)}</p>
                </div>
                <p className="mono text-xs text-[var(--muted)] tabular-nums shrink-0">
                  {formatLatency(r.latency_ms)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ── ActionCard ────────────────────────────────────────────────────────────────

function ActionCard({
  icon: Icon, iconColor, title, description, cta, ctaColor, onClick,
}: {
  icon: typeof Cpu
  iconColor: string
  title: string
  description: string
  cta: string
  ctaColor: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="p-5 rounded-xl border border-[var(--border)] bg-[var(--surface)]
        hover:bg-[var(--surface-strong)] transition-colors text-left group"
    >
      <Icon size={18} className={`${iconColor} mb-3`} />
      <p className="text-sm font-semibold text-[var(--ink)] mb-1">{title}</p>
      <p className="text-xs text-[var(--subtle)] leading-relaxed">{description}</p>
      <div className={`flex items-center gap-1 mt-3 text-xs ${ctaColor} group-hover:gap-1.5 transition-all`}>
        {cta} <ArrowRight size={11} />
      </div>
    </button>
  )
}
