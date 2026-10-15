import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Activity, Clock, AlertCircle, ArrowRight,
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

// ── Quota section ──────────────────────────────────────────────────────────────

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
  const fetchGenRef = useRef(0)

  const fetchQuota = useCallback(async (retry = false): Promise<void> => {
    const gen = fetchGenRef.current
    setQuota({ status: 'loading' })
    try {
      const headers = await getAuthHeaders()
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

  // ── Loading state ──
  if (authState.status === 'fetching_nonce' || authState.status === 'signing' || quota.status === 'loading') {
    return (
      <div className="rounded-2xl border border-[var(--border)] p-5 mb-6" style={{ background: 'var(--surface)' }}>
        <div className="flex items-center gap-2 mb-3">
          <Gauge size={13} className="text-[var(--subtle)]" />
          <span className="text-[11px] text-[var(--subtle)] uppercase tracking-widest font-medium">Free Tier Quota</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <Loader2 size={13} className="animate-spin shrink-0" />
          <span>
            {authState.status === 'fetching_nonce' ? 'Fetching auth nonce…'
              : authState.status === 'signing' ? 'Awaiting wallet signature…'
              : 'Loading quota…'}
          </span>
        </div>
      </div>
    )
  }

  // ── Auth error ──
  if (authState.status === 'error') {
    return (
      <div className="rounded-2xl border p-5 mb-6"
        style={{ borderColor: 'rgba(224,123,106,0.25)', background: 'rgba(224,123,106,0.06)' }}>
        <div className="flex items-start gap-3">
          <ShieldOff size={14} className="text-[var(--danger)] shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-[var(--ink)]">Authentication error</p>
            <p className="text-xs text-[var(--muted)] mt-0.5">{authState.message}</p>
            <p className="text-xs text-[var(--subtle)] mt-1">Quota information requires a valid wallet signature.</p>
          </div>
        </div>
      </div>
    )
  }

  // ── API error ──
  if (quota.status === 'error') {
    return (
      <div className="rounded-2xl border border-[var(--border)] p-5 mb-6" style={{ background: 'var(--surface)' }}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Gauge size={13} className="text-[var(--subtle)]" />
            <span className="text-[11px] text-[var(--subtle)] uppercase tracking-widest font-medium">Free Tier Quota</span>
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
          <p className="text-xs text-[var(--muted)]">Quota information is temporarily unavailable.</p>
        </div>
      </div>
    )
  }

  if (quota.status !== 'ok') return null

  const q = quota.data
  const usedReq  = q.used_requests
  const limitReq = q.limit_requests
  const pct      = limitReq > 0 ? Math.min(100, Math.round((usedReq / limitReq) * 100)) : 0
  const remaining = Math.max(0, limitReq - usedReq)
  const exhausted = remaining === 0
  const warning   = pct >= 80 && !exhausted

  const resetsAtMs = q.resets_at
  const resetsIn   = resetsAtMs > Date.now()
    ? Math.ceil((resetsAtMs - Date.now()) / 3_600_000)
    : null
  const resetLabel = resetsIn != null
    ? resetsIn <= 1 ? 'Resets in < 1h' : `Resets in ~${resetsIn}h`
    : 'Resets at UTC midnight'

  const usedTok  = q.used_tokens
  const limitTok = q.limit_tokens
  const tokPct   = limitTok > 0 ? Math.min(100, Math.round((usedTok / limitTok) * 100)) : 0

  const barStyle = exhausted
    ? { background: 'var(--danger)' }
    : warning
      ? { background: '#c9a04a' }
      : { background: 'var(--sage)' }

  const cardBorderStyle = exhausted
    ? { borderColor: 'rgba(224,123,106,0.25)', background: 'rgba(224,123,106,0.04)' }
    : warning
      ? { borderColor: 'rgba(201,160,74,0.2)', background: 'rgba(201,160,74,0.03)' }
      : { borderColor: 'var(--border)', background: 'var(--surface)' }

  return (
    <div className="rounded-2xl border p-5 mb-6" style={cardBorderStyle}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <Gauge size={13} className="text-[var(--subtle)]" />
          <span className="text-[11px] text-[var(--subtle)] uppercase tracking-widest font-medium">
            Free Tier Quota
          </span>
          {q.global_circuit_breaker_tripped && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full text-[var(--danger)]"
              style={{ background: 'rgba(224,123,106,0.12)', border: '1px solid rgba(224,123,106,0.2)' }}
            >
              Service limited
            </span>
          )}
        </div>
        <button
          onClick={() => { fetchGenRef.current += 1; void fetchQuota() }}
          className="text-[var(--subtle)] hover:text-[var(--ink)] transition-colors p-1 rounded-lg hover:bg-[var(--surface-strong)]"
          aria-label="Refresh quota"
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {/* Requests bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-[var(--muted)]">Requests</span>
          <span className="text-xs tabular-nums font-medium text-[var(--ink)]">
            {usedReq.toLocaleString()} / {limitReq.toLocaleString()}
          </span>
        </div>
        <div
          className="h-1.5 rounded-full overflow-hidden"
          style={{ background: 'var(--surface-muted)' }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pct}% of daily request quota used`}
        >
          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, ...barStyle }} />
        </div>
      </div>

      {/* Tokens bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-[var(--muted)]">Tokens</span>
          <span className="text-xs tabular-nums text-[var(--subtle)]">
            {usedTok.toLocaleString()} / {limitTok.toLocaleString()}
          </span>
        </div>
        <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--surface-muted)' }}>
          <div
            className="h-full rounded-full transition-all duration-300 opacity-60"
            style={{ width: `${tokPct}%`, ...barStyle }}
          />
        </div>
      </div>

      {/* Status row */}
      <div className="flex items-center justify-between pt-3 border-t border-[var(--border)]">
        <div>
          {exhausted ? (
            <p className="text-xs font-medium text-[var(--danger)]">
              Daily allowance exhausted — {resetLabel}
            </p>
          ) : (
            <p className="text-xs text-[var(--muted)]">
              {remaining.toLocaleString()} request{remaining !== 1 ? 's' : ''} remaining — {resetLabel}
            </p>
          )}
          {q.global_circuit_breaker_tripped && q.global_reason && (
            <p className="text-[11px] text-[var(--danger)] opacity-70 mt-0.5">{q.global_reason}</p>
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
        <div className="mt-3 px-3 py-2.5 rounded-xl"
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Your free tier renews at UTC midnight. USDC-based top-ups will be available in a future update.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard({ onNavigate }: Props) {
  const { address, chainId, isConnected } = useAccount()
  const { authState, getAuthHeaders, invalidate } = useAuth()
  const arcChain = requireChain(ARC_MAINNET_ID)
  const isOnArc  = chainId === ARC_MAINNET_ID

  const [statsState, setStatsState] = useState<
    | { loading: true;  data: null;       error: null   }
    | { loading: false; data: UsageStats; error: null   }
    | { loading: false; data: null;       error: string }
  >({ loading: true, data: null, error: null })

  useEffect(() => {
    let cancelled = false
    void api.usageStats(address)
      .then((s) => { if (!cancelled) setStatsState({ loading: false, data: s,    error: null    }) })
      .catch((e: unknown) => { if (!cancelled) setStatsState({ loading: false, data: null, error: String(e) }) })
    return () => { cancelled = true }
  }, [address])

  const statsLoading = statsState.loading
  const stats        = statsState.data
  const statsError   = statsState.error

  return (
    <div>

      {/* ── Full-bleed hero ── */}
      <section className="relative overflow-hidden" style={{ minHeight: 'min(520px, 62vh)' }}>
        {/* Forest illustration backdrop */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(160deg, #0a1c13 0%, #0d2219 45%, #091710 100%)',
          }}
        />
        {/* SVG tree silhouettes */}
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox="0 0 800 520"
          preserveAspectRatio="xMidYMax slice"
          aria-hidden="true"
          style={{ opacity: 0.45 }}
        >
          {/* Distant tree line */}
          <path d="M0 380 Q40 300 80 340 Q110 270 150 310 Q190 240 230 290 Q270 210 310 270
            Q350 230 390 280 Q430 200 470 265 Q510 220 550 275 Q590 240 630 280
            Q670 210 710 270 Q750 240 800 280 L800 520 L0 520 Z"
            fill="#0d2b1c" />
          {/* Mid tree line */}
          <path d="M-20 420 Q20 340 60 380 Q90 310 130 360 Q165 280 200 340
            Q240 300 275 350 Q310 270 350 330 Q385 290 420 345
            Q460 300 500 360 Q535 310 570 370 Q610 320 650 380
            Q690 330 730 390 Q765 345 800 390 L820 520 L-20 520 Z"
            fill="#0b2418" />
          {/* Foreground tree forms */}
          <path d="M-10 460 Q15 390 50 430 Q80 360 110 410 Q145 370 175 420
            Q210 380 240 430 Q275 385 305 440 L320 520 L-10 520 Z"
            fill="#091f15" />
          <path d="M480 460 Q510 380 545 430 Q580 360 615 410 Q650 375 680 430
            Q715 385 750 440 Q775 400 810 460 L820 520 L480 520 Z"
            fill="#091f15" />
          {/* Water ripples */}
          <ellipse cx="400" cy="490" rx="320" ry="18" fill="none" stroke="#1a4a30" strokeWidth="1" opacity="0.6" />
          <ellipse cx="400" cy="502" rx="260" ry="12" fill="none" stroke="#1a4a30" strokeWidth="0.8" opacity="0.4" />
          <ellipse cx="400" cy="511" rx="200" ry="8" fill="none" stroke="#1a4a30" strokeWidth="0.6" opacity="0.3" />
          {/* Tree canopy detail */}
          <path d="M120 180 Q160 110 200 160 Q215 100 250 150 Q285 80 320 140
            Q355 90 390 145 Q425 75 455 135 Q490 95 520 150 Q555 80 590 145
            Q620 100 655 155 Q680 95 710 150 L730 260 Q690 280 650 270
            Q600 290 550 275 Q500 295 450 280 Q400 300 350 285
            Q300 305 250 288 Q200 308 155 290 Q120 275 80 285 L80 200 Z"
            fill="#0c2619" />
          {/* Branch lines */}
          <line x1="200" y1="165" x2="185" y2="190" stroke="#1b5c35" strokeWidth="1.5" opacity="0.5" />
          <line x1="320" y1="145" x2="310" y2="175" stroke="#1b5c35" strokeWidth="1.5" opacity="0.5" />
          <line x1="450" y1="138" x2="440" y2="168" stroke="#1b5c35" strokeWidth="1.5" opacity="0.5" />
          <line x1="590" y1="148" x2="582" y2="178" stroke="#1b5c35" strokeWidth="1.5" opacity="0.5" />
        </svg>
        {/* Overlay gradient — text sits over this */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to bottom, rgba(12,26,20,0.10) 0%, rgba(12,26,20,0.25) 50%, rgba(12,26,20,0.85) 88%, var(--bg) 100%)',
          }}
        />

        {/* Hero content */}
        <div className="relative z-10 px-6 sm:px-10 lg:px-16 pt-14 pb-20 max-w-3xl">
          <h1
            className="display-serif text-[var(--ink)] leading-[1.05] mb-6"
            style={{ fontSize: 'clamp(3rem, 7vw, 5rem)' }}
          >
            Every model.<br />Your way.
          </h1>
          <p
            className="text-[var(--ink-2)] leading-relaxed mb-10 max-w-lg"
            style={{ fontSize: 'clamp(1rem, 2vw, 1.125rem)', opacity: 0.85 }}
          >
            A place to explore AI, bring ideas to life, and build with the models you choose.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => onNavigate('playground')}
              className="btn-primary"
              style={{ fontSize: '0.9375rem', padding: '0.7rem 1.5rem' }}
            >
              Open Playground <ArrowRight size={15} />
            </button>
            <button
              onClick={() => onNavigate('marketplace')}
              className="btn-outline"
              style={{ fontSize: '0.9375rem', padding: '0.7rem 1.5rem' }}
            >
              Explore catalogue <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </section>

      {/* ── Body content ── */}
      <div className="px-5 sm:px-8 lg:px-12 py-10 max-w-5xl mx-auto">

        {/* Wrong-network banner */}
        {isConnected && !isOnArc && (
          <div
            className="mb-6 flex items-start gap-3 px-4 py-3.5 rounded-2xl"
            style={{ background: 'rgba(201,160,74,0.07)', border: '1px solid rgba(201,160,74,0.2)' }}
          >
            <AlertCircle size={14} className="mt-0.5 shrink-0" style={{ color: '#c9a04a' }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-[var(--ink)]">Wrong network</p>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                Switch to {arcChain.name} (chain {ARC_MAINNET_ID}) to enable payments. Currently on chain {chainId}.
              </p>
            </div>
          </div>
        )}

        {/* Not-connected prompt */}
        {!isConnected && (
          <div
            className="rounded-2xl border border-[var(--border)] mb-8 p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5"
            style={{ background: 'var(--surface)' }}
          >
            <div>
              <p className="text-base font-semibold text-[var(--ink)] mb-1">Connect a wallet to get started</p>
              <p className="text-sm text-[var(--muted)] leading-relaxed max-w-sm">
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
          <div
            className="mb-6 flex items-center gap-3 px-4 py-2.5 rounded-2xl border border-[var(--border)]"
            style={{ background: 'var(--surface)' }}
          >
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: isOnArc ? 'var(--sage)' : '#c9a04a', boxShadow: isOnArc ? '0 0 5px var(--sage)' : 'none' }}
              />
              <span className="mono text-xs text-[var(--muted)] truncate tabular-nums">{address}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {authState.status === 'signed' && (
                <span
                  className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full text-[var(--sage)]"
                  style={{ background: 'rgba(138,171,122,0.12)', border: '1px solid rgba(138,171,122,0.2)' }}
                >
                  <ShieldCheck size={10} /> Verified
                </span>
              )}
              {(authState.status === 'fetching_nonce' || authState.status === 'signing') && (
                <span
                  className="flex items-center gap-1 text-[10px] text-[var(--muted)] px-2 py-0.5 rounded-full"
                  style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
                >
                  <Loader2 size={10} className="animate-spin" />
                  {authState.status === 'signing' ? 'Signing…' : 'Auth…'}
                </span>
              )}
              {authState.status === 'error' && (
                <span
                  className="flex items-center gap-1 text-[10px] text-[var(--danger)] px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(224,123,106,0.1)', border: '1px solid rgba(224,123,106,0.2)' }}
                >
                  <ShieldOff size={10} /> Auth error
                </span>
              )}
              <span className="text-xs text-[var(--subtle)]">
                {isOnArc ? arcChain.name : `Chain ${chainId}`}
              </span>
              {isOnArc && <CheckCircle size={13} className="text-[var(--sage)]" />}
            </div>
          </div>
        )}

        {/* Quota */}
        {isConnected && address && (
          <QuotaSection
            authState={authState}
            getAuthHeaders={getAuthHeaders}
            invalidate={invalidate}
            onNavigate={onNavigate}
          />
        )}

        {/* ── Feature description rows — Manyways-style ── */}
        <div className="mb-10 space-y-0">
          <FeatureRow
            eyebrow="Your tools. Your models."
            heading="Build the way you want."
            body="Connect your apps and tools. Choose your models and manage access in one place, authenticated with your wallet."
            cta="Explore catalogue"
            onCta={() => onNavigate('marketplace')}
            align="left"
          />
          <div className="h-px w-full" style={{ background: 'var(--border)' }} />
          <FeatureRow
            eyebrow="An idea is enough to get started."
            heading="Test models in the playground."
            body="Send a prompt to any model in the catalogue. Compare responses, measure latency, and find what works for you."
            cta="Open playground"
            onCta={() => onNavigate('playground')}
            align="right"
          />
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {([
            {
              label: 'Total Requests',
              displayValue: statsLoading ? null : String(stats?.total_requests ?? 0),
              icon: Activity,
              accentStyle: { color: 'var(--sage)' },
            },
            {
              label: 'Total Tokens',
              displayValue: statsLoading ? null : formatTokens(stats?.total_tokens ?? null),
              icon: TrendingUp,
              accentStyle: { color: 'var(--accent)' },
            },
            {
              label: 'Avg Latency',
              displayValue: null as string | null,
              icon: Clock,
              accentStyle: { color: '#c9a04a' },
            },
          ]).map(({ label, displayValue, icon: Icon, accentStyle }) => (
            <div
              key={label}
              className="rounded-2xl border border-[var(--border)] p-5"
              style={{ background: 'var(--surface)' }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Icon size={14} style={accentStyle} />
                <span className="text-[11px] text-[var(--subtle)] uppercase tracking-widest font-medium">
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

        {/* Recent activity */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold text-[var(--subtle)] uppercase tracking-widest">
              Recent Activity
            </h2>
            {stats && stats.total_requests > 0 && (
              <button
                onClick={() => onNavigate('usage')}
                className="text-xs text-[var(--muted)] hover:text-[var(--ink)] flex items-center gap-1 transition-colors"
              >
                View all <ArrowRight size={12} />
              </button>
            )}
          </div>

          {statsError && (
            <div
              className="flex items-center gap-2 p-3 rounded-xl"
              style={{ background: 'rgba(224,123,106,0.08)', border: '1px solid rgba(224,123,106,0.2)' }}
            >
              <AlertCircle size={14} className="text-[var(--danger)] shrink-0" />
              <p className="text-sm text-[var(--danger)]">{statsError}</p>
            </div>
          )}

          {!statsLoading && !statsError && !stats?.recent?.length && (
            <div className="py-14 text-center rounded-2xl" style={{ border: '1px dashed var(--border)' }}>
              <Zap size={22} className="text-[var(--subtle)] mx-auto mb-3" />
              <p className="text-sm text-[var(--muted)]">No inference requests yet</p>
              <p className="text-xs text-[var(--subtle)] mt-1">Run your first prompt in the playground</p>
              <button onClick={() => onNavigate('playground')} className="btn-primary mt-5">
                Open Playground
              </button>
            </div>
          )}

          {!statsLoading && stats?.recent && stats.recent.length > 0 && (
            <div
              className="rounded-2xl border border-[var(--border)] overflow-hidden"
              style={{ background: 'var(--surface)' }}
            >
              {stats.recent.map((r, i) => (
                <div
                  key={r.id}
                  className={`flex items-center gap-3 px-5 py-3.5 ${
                    i < stats.recent.length - 1 ? 'border-b border-[var(--border)]' : ''
                  }`}
                >
                  {r.status === 'success'
                    ? <CheckCircle size={13} className="text-[var(--sage)] shrink-0" />
                    : <XCircle size={13} className="text-[var(--danger)] shrink-0" />
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
    </div>
  )
}

// ── FeatureRow ────────────────────────────────────────────────────────────────

function FeatureRow({
  eyebrow, heading, body, cta, onCta, align,
}: {
  eyebrow: string
  heading: string
  body: string
  cta: string
  onCta: () => void
  align: 'left' | 'right'
}) {
  return (
    <div
      className={`py-12 flex flex-col gap-4 ${align === 'right' ? 'sm:items-end sm:text-right' : ''}`}
    >
      <p className="text-xs text-[var(--subtle)] uppercase tracking-widest font-medium">{eyebrow}</p>
      <h3
        className="display-serif text-[var(--ink)] leading-tight max-w-sm"
        style={{ fontSize: 'clamp(1.5rem, 3vw, 2.125rem)' }}
      >
        {heading}
      </h3>
      <p className="text-sm text-[var(--muted)] leading-relaxed max-w-md">{body}</p>
      <button
        onClick={onCta}
        className="flex items-center gap-2 text-sm font-medium text-[var(--ink-2)] hover:text-[var(--ink)] transition-colors group w-fit"
        style={align === 'right' ? { alignSelf: 'flex-end' } : {}}
      >
        {cta}
        <ArrowRight size={14} className="group-hover:translate-x-0.5 transition-transform" />
      </button>
    </div>
  )
}
