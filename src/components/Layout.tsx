import { useState } from 'react'
import { useAccount, useDisconnect } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { Menu, X, LogOut, Wallet, ChevronDown, ExternalLink } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

export type Page = 'home' | 'dashboard' | 'marketplace' | 'playground' | 'usage' | 'wallet'

interface Props {
  page: Page
  onNavigate: (p: Page) => void
  children: React.ReactNode
}

// ── Constants ──────────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS = '0xcae728e7b5d193f2bff4c11feba6aac06dd793a8'
const CONTRACT_EXPLORER_URL =
  `https://explorer.testnet.arc.io/address/${CONTRACT_ADDRESS}`

// App inner-nav items (shown when NOT on the home/landing page)
const APP_NAV: Array<{ id: Page; label: string }> = [
  { id: 'dashboard',   label: 'Dashboard'  },
  { id: 'marketplace', label: 'Catalogue'  },
  { id: 'playground',  label: 'Playground' },
  { id: 'usage',       label: 'Usage'      },
]

// ── Wordmark ───────────────────────────────────────────────────────────────────

function Wordmark({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2.5 group select-none" aria-label="InferMesh home">
      <svg width="26" height="26" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <path d="M14 2 L25 8 L25 20 L14 26 L3 20 L3 8 Z"
          fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        <circle cx="14" cy="14" r="3.5" fill="var(--accent)" />
        <line x1="14" y1="8" x2="14" y2="10.5" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
        <line x1="14" y1="17.5" x2="14" y2="20" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
        <line x1="8.5" y1="11" x2="10.5" y2="12.1" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
        <line x1="17.5" y1="15.9" x2="19.5" y2="17" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
        <line x1="8.5" y1="17" x2="10.5" y2="15.9" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
        <line x1="17.5" y1="12.1" x2="19.5" y2="11" stroke="var(--accent)" strokeWidth="1.2" opacity="0.6" />
      </svg>
      <span className="display-serif tracking-tight leading-none"
        style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--ink)' }}>
        InferMesh
      </span>
    </button>
  )
}

// ── WalletChip ─────────────────────────────────────────────────────────────────

function WalletChip({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const [open, setOpen] = useState(false)

  if (!isConnected || !address) {
    return <ConnectKitButton />
  }

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3.5 py-2 rounded-full transition-colors text-sm"
        style={{
          background: 'transparent',
          border: '1px solid var(--border-strong)',
        }}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: 'var(--sage)', boxShadow: '0 0 5px var(--sage)' }}
        />
        <span className="mono text-xs tabular-nums" style={{ color: 'var(--ink-2)' }}>
          {short}
        </span>
        <ChevronDown size={11}
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          style={{ color: 'var(--subtle)' }} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full mt-2 z-50 w-44 rounded-2xl overflow-hidden py-1 shadow-2xl"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
          >
            <button
              onClick={() => { onNavigate('wallet'); setOpen(false) }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs transition-colors text-left"
              style={{ color: 'var(--muted)' }}
            >
              <Wallet size={13} /> View wallet
            </button>
            <div className="h-px mx-3 my-0.5" style={{ background: 'var(--border)' }} />
            <button
              onClick={() => { disconnect(); setOpen(false) }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs transition-colors text-left"
              style={{ color: 'var(--danger)' }}
            >
              <LogOut size={13} /> Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Layout ─────────────────────────────────────────────────────────────────────

export default function Layout({ page, onNavigate, children }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const isHome = page === 'home'

  return (
    <div className="min-h-dvh flex flex-col" style={{ background: 'var(--bg)' }}>

      {/* ── Header ── */}
      <header
        className="h-[60px] shrink-0 flex items-center justify-between px-5 sm:px-8 gap-4"
        style={{
          background: 'rgba(12,26,20,0.92)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid var(--border)',
          position: 'sticky',
          top: 0,
          zIndex: 30,
        }}
      >
        {/* Left: hamburger (mobile) + wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden -ml-1 p-1 rounded-md transition-colors"
            style={{ color: 'var(--subtle)' }}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <Wordmark onClick={() => onNavigate('home')} />
        </div>

        {/* Centre: desktop nav */}
        <nav className="hidden lg:flex items-center gap-0.5 flex-1 px-4">
          {isHome ? (
            /* Landing page nav: external links + catalogue */
            <>
              <a
                href={CONTRACT_EXPLORER_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm transition-all duration-150 font-medium"
                style={{ color: 'var(--subtle)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ink-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--subtle)')}
              >
                IM Contract <ExternalLink size={11} />
              </a>
              <button
                onClick={() => onNavigate('marketplace')}
                className="px-3.5 py-2 rounded-full text-sm transition-all duration-150 font-medium"
                style={{ color: 'var(--subtle)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ink-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--subtle)')}
              >
                Catalogue
              </button>
              <a
                href="https://github.com/askirawa/InferMesh"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm transition-all duration-150 font-medium"
                style={{ color: 'var(--subtle)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ink-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--subtle)')}
              >
                Docs <ExternalLink size={11} />
              </a>
            </>
          ) : (
            /* App inner nav */
            APP_NAV.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => onNavigate(id)}
                className="px-3.5 py-2 rounded-full text-sm transition-all duration-150 font-medium"
                style={
                  page === id
                    ? { color: 'var(--ink)', background: 'rgba(255,255,255,0.07)' }
                    : { color: 'var(--subtle)' }
                }
                onMouseEnter={(e) => {
                  if (page !== id) (e.currentTarget).style.color = 'var(--ink-2)'
                }}
                onMouseLeave={(e) => {
                  if (page !== id) (e.currentTarget).style.color = 'var(--subtle)'
                }}
              >
                {label}
              </button>
            ))
          )}
        </nav>

        {/* Right: Launch App (home only) + wallet */}
        <div className="flex items-center gap-3 shrink-0">
          {isHome && (
            <button
              onClick={() => onNavigate('dashboard')}
              className="hidden sm:inline-flex btn-primary"
              style={{ fontSize: '0.875rem', padding: '0.5rem 1.25rem' }}
            >
              Launch App
            </button>
          )}
          <WalletChip onNavigate={onNavigate} />
        </div>
      </header>

      {/* ── Mobile overlay ── */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Mobile drawer ── */}
      <aside
        className={`lg:hidden fixed top-0 left-0 h-full w-64 z-50 flex flex-col
          border-r transition-transform duration-200
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
        style={{ background: 'var(--surface-muted)', borderColor: 'var(--border)' }}
      >
        <div
          className="h-14 px-5 flex items-center justify-between border-b shrink-0"
          style={{ borderColor: 'var(--border)' }}
        >
          <Wordmark onClick={() => { onNavigate('home'); setMobileOpen(false) }} />
          <button
            onClick={() => setMobileOpen(false)}
            className="p-1 rounded-md"
            style={{ color: 'var(--subtle)' }}
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 px-3 py-5 flex flex-col gap-0.5 overflow-y-auto">
          {/* Landing-only links */}
          <a
            href={CONTRACT_EXPLORER_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-colors w-full"
            style={{ color: 'var(--muted)', textDecoration: 'none' }}
          >
            IM Contract <ExternalLink size={12} />
          </a>
          <a
            href="https://github.com/askirawa/InferMesh"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-colors w-full"
            style={{ color: 'var(--muted)', textDecoration: 'none' }}
          >
            Docs <ExternalLink size={12} />
          </a>

          <div className="h-px mx-1 my-2" style={{ background: 'var(--border)' }} />

          {/* App pages */}
          {[
            { id: 'dashboard' as Page,   label: 'Dashboard'  },
            { id: 'marketplace' as Page, label: 'Catalogue'  },
            { id: 'playground' as Page,  label: 'Playground' },
            { id: 'usage' as Page,       label: 'Usage'      },
            { id: 'wallet' as Page,      label: 'Wallet'     },
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => { onNavigate(id); setMobileOpen(false) }}
              className="flex items-center px-4 py-3 rounded-xl text-sm font-medium transition-colors w-full text-left"
              style={
                page === id
                  ? { background: 'var(--surface-strong)', color: 'var(--ink)' }
                  : { color: 'var(--muted)' }
              }
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Launch App */}
        <div className="px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={() => { onNavigate('dashboard'); setMobileOpen(false) }}
            className="btn-primary w-full justify-center text-sm"
          >
            Launch App
          </button>
        </div>
      </aside>

      {/* ── Content ── */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>

    </div>
  )
}
