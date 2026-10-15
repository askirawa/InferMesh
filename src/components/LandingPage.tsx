import { useEffect, useState } from 'react'
import {
  ArrowRight, ExternalLink, Zap, BookOpen, Database,
  ShieldCheck, Activity, Loader2, CheckCircle, AlertCircle,
} from 'lucide-react'
import { api } from '../lib/api'

// ── Constants ────────────────────────────────────────────────────────────────

const ARC_TESTNET_CHAIN_ID = 5042002
const CONTRACT_ADDRESS = '0xcae728e7b5d193f2bff4c11feba6aac06dd793a8'
const CONTRACT_EXPLORER_URL =
  `https://explorer.testnet.arc.io/address/${CONTRACT_ADDRESS}`
const ARC_TESTNET_EXPLORER = 'https://explorer.testnet.arc.io'
const ARC_TESTNET_RPC = 'https://rpc.testnet.arc.io'

// Silence the unused-variable warning — these are valid domain facts kept for
// future use in the network-status section and docs links.
void ARC_TESTNET_EXPLORER
void ARC_TESTNET_RPC
void ARC_TESTNET_CHAIN_ID

// ── Types ────────────────────────────────────────────────────────────────────

interface LiveStats {
  modelCount: number | null
  requestCount: number | null
  networkOk: boolean
}

// ── LandingPage ──────────────────────────────────────────────────────────────

interface Props {
  onLaunchApp: () => void
  onNavigate: (p: 'marketplace' | 'playground') => void
}

export default function LandingPage({ onLaunchApp, onNavigate }: Props) {
  const [stats, setStats] = useState<LiveStats>({
    modelCount: null,
    requestCount: null,
    networkOk: true,
  })
  const [statsLoading, setStatsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void Promise.allSettled([
      api.models(),
      api.usageStats(undefined),
      api.health(),
    ]).then(([modelsRes, usageRes, healthRes]) => {
      if (cancelled) return
      setStats({
        modelCount:
          modelsRes.status === 'fulfilled'
            ? (modelsRes.value.data ?? []).length
            : null,
        requestCount:
          usageRes.status === 'fulfilled'
            ? usageRes.value.total_requests
            : null,
        networkOk:
          healthRes.status === 'fulfilled' ? healthRes.value.ok : false,
      })
      setStatsLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  return (
    <div style={{ background: 'var(--bg)', color: 'var(--ink)' }}>

      {/* ── HERO ── */}
      <section className="relative overflow-hidden" style={{ minHeight: 'min(580px, 70vh)' }}>

        {/* Backdrop gradient */}
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(155deg, #0a1c13 0%, #0d2219 50%, #081610 100%)' }}
        />

        {/* SVG network mesh illustration */}
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox="0 0 900 580"
          preserveAspectRatio="xMidYMax slice"
          aria-hidden="true"
          style={{ opacity: 0.3 }}
        >
          {/* Node grid — scattered points suggesting a mesh network */}
          {[
            [680,80],[720,140],[760,95],[810,160],[850,110],
            [700,200],[740,255],[790,210],[830,270],[870,230],
            [660,320],[710,370],[750,330],[800,380],[845,340],
            [670,440],[720,480],[770,445],[820,490],[860,455],
          ].map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r="2.5" fill="var(--sage)" opacity="0.6" />
          ))}
          {/* Connecting lines */}
          {[
            [680,80,720,140],[720,140,760,95],[760,95,810,160],[810,160,850,110],
            [720,140,700,200],[760,95,740,255],[810,160,790,210],[850,110,830,270],
            [700,200,740,255],[740,255,790,210],[790,210,830,270],[830,270,870,230],
            [700,200,660,320],[740,255,710,370],[790,210,750,330],[830,270,800,380],
            [660,320,710,370],[710,370,750,330],[750,330,800,380],[800,380,845,340],
            [660,320,670,440],[710,370,720,480],[750,330,770,445],[800,380,820,490],
          ].map(([x1,y1,x2,y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="var(--sage)" strokeWidth="0.8" opacity="0.25" />
          ))}
          {/* Fade-out mask on left */}
          <defs>
            <linearGradient id="fadeLeft" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#0a1c13" stopOpacity="1" />
              <stop offset="45%" stopColor="#0a1c13" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect width="900" height="580" fill="url(#fadeLeft)" />
        </svg>

        {/* Bottom fade to background */}
        <div
          className="absolute inset-x-0 bottom-0"
          style={{ height: '40%', background: 'linear-gradient(to bottom, transparent, var(--bg))' }}
        />

        {/* Hero content */}
        <div className="relative z-10 px-6 sm:px-10 lg:px-20 pt-20 pb-24 max-w-2xl">

          {/* Eyebrow badge */}
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full mb-8 text-xs font-medium"
            style={{
              background: 'rgba(138,171,122,0.12)',
              border: '1px solid rgba(138,171,122,0.25)',
              color: 'var(--sage)',
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: 'var(--sage)', boxShadow: '0 0 6px var(--sage)' }}
            />
            Arc Testnet · Open Beta
          </div>

          {/* Headline */}
          <h1
            className="display-serif text-[var(--ink)] leading-[1.04] mb-6"
            style={{ fontSize: 'clamp(2.6rem, 6.5vw, 4.5rem)' }}
          >
            Every AI model.<br />One open inference<br />layer.
          </h1>

          {/* Supporting copy */}
          <p
            className="text-[var(--ink-2)] leading-relaxed mb-10 max-w-lg"
            style={{ fontSize: 'clamp(1rem, 1.8vw, 1.1rem)', opacity: 0.85 }}
          >
            InferMesh brings AI model discovery, inference requests, and verifiable
            on-chain activity together in one unified platform, powered by Arc.
          </p>

          {/* CTA row */}
          <div className="flex flex-wrap items-center gap-3 mb-10">
            <button
              onClick={() => onNavigate('marketplace')}
              className="btn-primary"
              style={{ fontSize: '0.9375rem', padding: '0.75rem 1.625rem' }}
            >
              Explore Models <ArrowRight size={15} />
            </button>
            <button
              onClick={() => onNavigate('playground')}
              className="btn-outline"
              style={{ fontSize: '0.9375rem', padding: '0.75rem 1.625rem' }}
            >
              Open Playground <ArrowRight size={15} />
            </button>
          </div>

          {/* Network status strip */}
          <NetworkStatusStrip networkOk={stats.networkOk} loading={statsLoading} />
        </div>
      </section>

      {/* ── LIVE PLATFORM STATS ── */}
      <section className="px-6 sm:px-10 lg:px-20 py-16 max-w-5xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            label="Available Models"
            value={statsLoading ? null : stats.modelCount}
            sublabel="via Orbio gateway"
            loading={statsLoading}
          />
          <StatCard
            label="Inference Requests"
            value={statsLoading ? null : stats.requestCount}
            sublabel="recorded on platform"
            loading={statsLoading}
          />
          <StatCard
            label="Registry Contract"
            value={null}
            sublabel={
              <a
                href={CONTRACT_EXPLORER_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 transition-colors"
                style={{ color: 'var(--sage)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ink-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--sage)')}
              >
                View on Arc Testnet <ExternalLink size={11} />
              </a>
            }
            loading={false}
            isLink
          />
        </div>
      </section>

      {/* ── FEATURE CARDS ── */}
      <section className="px-6 sm:px-10 lg:px-20 pb-16 max-w-5xl mx-auto">

        <div className="mb-10">
          <p className="text-xs text-[var(--subtle)] uppercase tracking-widest font-medium mb-3">
            Platform capabilities
          </p>
          <h2
            className="display-serif text-[var(--ink)] leading-tight"
            style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)' }}
          >
            Built for open AI infrastructure.
          </h2>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <FeatureCard
            icon={Database}
            title="Model Catalogue"
            description="Browse hundreds of AI models across providers. Filter by capability, price, context window, and modality. Compare side by side before committing."
            badge="Live"
            badgeStyle="ok"
            onClick={() => onNavigate('marketplace')}
            cta="Browse catalogue"
          />
          <FeatureCard
            icon={Zap}
            title="AI Playground"
            description="Send prompts to any listed model through the Orbio inference gateway. Measure latency, token usage, and response quality in real time."
            badge="Live"
            badgeStyle="ok"
            onClick={() => onNavigate('playground')}
            cta="Open Playground"
          />
          <FeatureCard
            icon={ShieldCheck}
            title="On-chain Registry"
            description="Inference request records are anchored on Arc Testnet. Inspect the deployed InferMeshRegistry contract directly on the block explorer."
            badge="Testnet"
            badgeStyle="testnet"
            href={CONTRACT_EXPLORER_URL}
            cta="View contract"
          />
          <FeatureCard
            icon={BookOpen}
            title="Transparent Infrastructure"
            description="Verifiable AI activity and USDC-based settlement are in active development. The architecture is designed for open, auditable inference at scale."
            badge="Coming"
            badgeStyle="coming"
          />
        </div>
      </section>

      {/* ── FEATURE ROWS — Manyways style ── */}
      <section
        className="border-t"
        style={{ borderColor: 'var(--border)' }}
      >
        <FeatureRow
          eyebrow="An open model layer."
          heading="Discover models from every major provider."
          body="From OpenAI and Anthropic to open-source community models — InferMesh aggregates the full catalogue through a single, wallet-authenticated inference endpoint."
          cta="Explore catalogue"
          onCta={() => onNavigate('marketplace')}
          align="left"
        />
        <div style={{ height: '1px', background: 'var(--border)' }} />
        <FeatureRow
          eyebrow="Test before you build."
          heading="Real inference in the Playground."
          body="Select a model, write a prompt, and get a real response. Latency, token counts, and cost are all reported per request. No guessing, no mocking."
          cta="Open Playground"
          onCta={() => onNavigate('playground')}
          align="right"
        />
      </section>

      {/* ── REGISTRY CTA ── */}
      <section className="px-6 sm:px-10 lg:px-20 py-20 max-w-5xl mx-auto">
        <div
          className="rounded-2xl p-8 sm:p-12 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-8"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
          }}
        >
          <div className="max-w-md">
            <p className="text-xs text-[var(--subtle)] uppercase tracking-widest font-medium mb-3">
              On-chain · Arc Testnet
            </p>
            <h3
              className="display-serif text-[var(--ink)] leading-tight mb-3"
              style={{ fontSize: 'clamp(1.4rem, 2.5vw, 1.875rem)' }}
            >
              Inspect the InferMesh Registry.
            </h3>
            <p className="text-sm text-[var(--muted)] leading-relaxed mb-2">
              The InferMeshRegistry contract records inference requests on Arc Testnet.
              All activity is publicly verifiable on the block explorer.
            </p>
            <p
              className="mono text-xs break-all"
              style={{ color: 'var(--subtle)' }}
            >
              {CONTRACT_ADDRESS}
            </p>
          </div>
          <div className="flex flex-col gap-3 shrink-0">
            <a
              href={CONTRACT_EXPLORER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary"
              style={{ fontSize: '0.9rem', padding: '0.7rem 1.5rem' }}
            >
              View on Explorer <ExternalLink size={14} />
            </a>
            <button
              onClick={onLaunchApp}
              className="btn-outline"
              style={{ fontSize: '0.9rem', padding: '0.7rem 1.5rem' }}
            >
              Launch App <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer
        className="border-t px-6 sm:px-10 lg:px-20 py-10"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <InferMeshMark />
            <span
              className="display-serif"
              style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--ink)' }}
            >
              InferMesh
            </span>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm" style={{ color: 'var(--subtle)' }}>
            <a
              href={CONTRACT_EXPLORER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[var(--ink-2)]"
            >
              IM Contract
            </a>
            <button
              onClick={() => onNavigate('marketplace')}
              className="transition-colors hover:text-[var(--ink-2)]"
            >
              Catalogue
            </button>
            <button
              onClick={() => onNavigate('playground')}
              className="transition-colors hover:text-[var(--ink-2)]"
            >
              Playground
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--subtle)' }}>
            Arc Testnet · Open Beta
          </p>
        </div>
      </footer>

    </div>
  )
}

// ── NetworkStatusStrip ────────────────────────────────────────────────────────

function NetworkStatusStrip({ networkOk, loading }: { networkOk: boolean; loading: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs" style={{ color: 'var(--subtle)' }}>
      <span className="flex items-center gap-1.5">
        {loading ? (
          <Loader2 size={10} className="animate-spin" />
        ) : networkOk ? (
          <CheckCircle size={10} style={{ color: 'var(--sage)' }} />
        ) : (
          <AlertCircle size={10} style={{ color: 'var(--danger)' }} />
        )}
        {loading ? 'Checking network…' : networkOk ? 'Network operational' : 'Network degraded'}
      </span>
      <span
        className="h-3 w-px"
        style={{ background: 'var(--border)' }}
        aria-hidden="true"
      />
      <span className="flex items-center gap-1.5">
        <Activity size={10} />
        Inference records on Arc Testnet
      </span>
    </div>
  )
}

// ── StatCard ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sublabel,
  loading,
  isLink = false,
}: {
  label: string
  value: number | null
  sublabel: React.ReactNode
  loading: boolean
  isLink?: boolean
}) {
  return (
    <div
      className="rounded-2xl p-6"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <p
        className="text-[10px] uppercase tracking-widest font-medium mb-3"
        style={{ color: 'var(--subtle)' }}
      >
        {label}
      </p>
      {loading ? (
        <div className="flex items-center gap-2 mb-2" style={{ color: 'var(--muted)' }}>
          <Loader2 size={14} className="animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : isLink ? (
        <p
          className="display text-3xl font-semibold tabular-nums tracking-tight mb-1"
          style={{ color: 'var(--subtle)' }}
        >
          —
        </p>
      ) : (
        <p
          className="display text-3xl font-semibold tabular-nums tracking-tight mb-1"
          style={{ color: 'var(--ink)' }}
        >
          {value != null ? value.toLocaleString() : '—'}
        </p>
      )}
      <div className="text-xs" style={{ color: 'var(--muted)' }}>
        {sublabel}
      </div>
    </div>
  )
}

// ── FeatureCard ───────────────────────────────────────────────────────────────

function FeatureCard({
  icon: Icon,
  title,
  description,
  badge,
  badgeStyle,
  onClick,
  href,
  cta,
}: {
  icon: React.ElementType
  title: string
  description: string
  badge: string
  badgeStyle: 'ok' | 'testnet' | 'coming'
  onClick?: () => void
  href?: string
  cta?: string
}) {
  const badgeColors: Record<string, { bg: string; color: string; border: string }> = {
    ok:      { bg: 'rgba(138,171,122,0.12)', color: 'var(--sage)',    border: 'rgba(138,171,122,0.25)' },
    testnet: { bg: 'rgba(201,160,74,0.10)',  color: '#c9a04a',        border: 'rgba(201,160,74,0.2)'   },
    coming:  { bg: 'rgba(255,255,255,0.05)', color: 'var(--subtle)',  border: 'rgba(255,255,255,0.08)' },
  }
  const bc = badgeColors[badgeStyle]

  const inner = (
    <div
      className="h-full rounded-2xl p-6 flex flex-col gap-4 group transition-all duration-150"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
      }}
    >
      <div className="flex items-start justify-between">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
        >
          <Icon size={18} style={{ color: 'var(--sage)' }} />
        </div>
        <span
          className="text-[10px] px-2 py-1 rounded-full font-medium uppercase tracking-wide"
          style={{ background: bc.bg, color: bc.color, border: `1px solid ${bc.border}` }}
        >
          {badge}
        </span>
      </div>
      <div className="flex-1">
        <h3 className="display text-base font-semibold mb-2" style={{ color: 'var(--ink)' }}>
          {title}
        </h3>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
          {description}
        </p>
      </div>
      {cta && (
        <div
          className="flex items-center gap-1.5 text-xs font-medium transition-colors"
          style={{ color: 'var(--muted)' }}
        >
          {cta} <ArrowRight size={11} />
        </div>
      )}
    </div>
  )

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block hover:scale-[1.01] transition-transform"
        style={{ textDecoration: 'none' }}
      >
        {inner}
      </a>
    )
  }

  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="block text-left w-full hover:scale-[1.01] transition-transform disabled:cursor-default"
    >
      {inner}
    </button>
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
      className={`px-6 sm:px-10 lg:px-20 py-14 max-w-5xl mx-auto flex flex-col gap-4
        ${align === 'right' ? 'sm:items-end sm:text-right' : ''}`}
    >
      <p className="text-xs uppercase tracking-widest font-medium" style={{ color: 'var(--subtle)' }}>
        {eyebrow}
      </p>
      <h3
        className="display-serif leading-tight max-w-sm"
        style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', color: 'var(--ink)' }}
      >
        {heading}
      </h3>
      <p className="text-sm leading-relaxed max-w-md" style={{ color: 'var(--muted)' }}>
        {body}
      </p>
      <button
        onClick={onCta}
        className="flex items-center gap-2 text-sm font-medium transition-colors group w-fit"
        style={align === 'right' ? { alignSelf: 'flex-end', color: 'var(--ink-2)' } : { color: 'var(--ink-2)' }}
      >
        {cta}
        <ArrowRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
      </button>
    </div>
  )
}

// ── InferMeshMark ─────────────────────────────────────────────────────────────

function InferMeshMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <path
        d="M14 2 L25 8 L25 20 L14 26 L3 20 L3 8 Z"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
      />
      <circle cx="14" cy="14" r="3.5" fill="var(--accent)" />
      <line x1="14" y1="8" x2="14" y2="10.5" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
      <line x1="14" y1="17.5" x2="14" y2="20" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
      <line x1="8.5" y1="11" x2="10.5" y2="12.1" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
      <line x1="17.5" y1="15.9" x2="19.5" y2="17" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
      <line x1="8.5" y1="17" x2="10.5" y2="15.9" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
      <line x1="17.5" y1="12.1" x2="19.5" y2="11" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
    </svg>
  )
}
