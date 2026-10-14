import { useState } from 'react'
import { useAccount, useDisconnect } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import {
  LayoutDashboard, Cpu, MessageSquare, Clock, Wallet,
  Menu, X, Zap, LogOut, ChevronDown, type LucideIcon,
} from 'lucide-react'

type Page = 'dashboard' | 'marketplace' | 'playground' | 'usage' | 'wallet'

interface Props {
  page: Page
  onNavigate: (p: Page) => void
  children: React.ReactNode
}

const NAV_ITEMS: Array<{ id: Page; label: string; icon: LucideIcon }> = [
  { id: 'dashboard',    label: 'Dashboard',     icon: LayoutDashboard },
  { id: 'marketplace',  label: 'Explore',        icon: Cpu },
  { id: 'playground',   label: 'Playground',     icon: MessageSquare },
  { id: 'usage',        label: 'Usage',          icon: Clock },
  { id: 'wallet',       label: 'Wallet',         icon: Wallet },
]

// Compact wallet chip shown in the desktop header once connected
function WalletChip({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const [menuOpen, setMenuOpen] = useState(false)

  if (!isConnected || !address) {
    return (
      <ConnectKitButton />
    )
  }

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border)]
          bg-[var(--surface)] hover:bg-[var(--surface-strong)] transition-colors text-sm"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
        <span className="mono text-[var(--ink)] tabular-nums text-xs">{short}</span>
        <ChevronDown size={12} className={`text-[var(--subtle)] transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-50 w-48 rounded-xl border border-[var(--border)]
            bg-[#141c24] shadow-xl overflow-hidden py-1">
            <button
              onClick={() => { onNavigate('wallet'); setMenuOpen(false) }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-[var(--muted)]
                hover:text-[var(--ink)] hover:bg-[var(--surface-strong)] transition-colors text-left"
            >
              <Wallet size={14} />
              View wallet
            </button>
            <div className="h-px bg-[var(--border)] mx-2 my-1" />
            <button
              onClick={() => { disconnect(); setMenuOpen(false) }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-400
                hover:bg-red-500/10 transition-colors text-left"
            >
              <LogOut size={14} />
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default function Layout({ page, onNavigate, children }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="min-h-dvh bg-[var(--bg)] flex flex-col">
      {/* ── Top header ── */}
      <header className="h-14 shrink-0 flex items-center justify-between px-4 sm:px-6
        border-b border-[var(--border)] bg-[var(--surface-muted)]">
        {/* Left: hamburger (mobile) + wordmark */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden text-[var(--muted)] hover:text-[var(--ink)] p-1 -ml-1 rounded-md"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <button
            onClick={() => onNavigate('dashboard')}
            className="flex items-center gap-2 group"
          >
            <div className="w-6 h-6 rounded-md bg-emerald-500 flex items-center justify-center">
              <Zap size={12} className="text-white" strokeWidth={2.5} />
            </div>
            <span className="display font-semibold text-[var(--ink)] text-[15px] tracking-tight">
              InferMesh
            </span>
          </button>
        </div>

        {/* Centre: desktop nav */}
        <nav className="hidden lg:flex items-center gap-0.5">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors
                ${page === id
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-strong)]'
                }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        {/* Right: wallet */}
        <div className="flex items-center gap-3">
          <WalletChip onNavigate={onNavigate} />
        </div>
      </header>

      {/* ── Mobile sidebar overlay ── */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={`lg:hidden fixed top-0 left-0 h-full w-64 z-50 flex flex-col
          border-r border-[var(--border)] bg-[#0f1821]
          transition-transform duration-200
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="h-14 px-5 flex items-center justify-between border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-emerald-500 flex items-center justify-center">
              <Zap size={12} className="text-white" strokeWidth={2.5} />
            </div>
            <span className="display font-semibold text-[var(--ink)] text-[15px] tracking-tight">
              InferMesh
            </span>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="text-[var(--subtle)] hover:text-[var(--ink)] p-1 rounded-md"
          >
            <X size={18} />
          </button>
        </div>
        <nav className="flex-1 px-3 py-4 flex flex-col gap-0.5">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => { onNavigate(id); setMobileOpen(false) }}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors w-full text-left
                ${page === id
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-strong)]'
                }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-[var(--border)]">
          <p className="text-[11px] text-[var(--subtle)] leading-relaxed">
            Powered by Orbio on Arc Mainnet
          </p>
        </div>
      </aside>

      {/* ── Page content ── */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
