import { useAccount, useReadContract, useSwitchChain, useDisconnect } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { erc20Abi } from 'viem'
import {
  Wallet, ExternalLink, AlertCircle, CheckCircle,
  Copy, Check, RefreshCw, LogOut, ShieldAlert,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { requireChain, getUsdc, buildAddressExplorerUrl } from '@/onchain-facts'
import { Amount, usdcDecimalsFor } from '@/onchain-money'
import { formatAddress } from '../lib/utils'

const ARC_MAINNET_ID = 5042

export default function WalletPage() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const { disconnect } = useDisconnect()
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle')
  const [disconnectError, setDisconnectError] = useState<string | null>(null)

  const arcChain = requireChain(ARC_MAINNET_ID)
  const usdcFact = getUsdc(ARC_MAINNET_ID)
  const isOnArc  = chainId === ARC_MAINNET_ID

  const { data: balance, isLoading: balanceLoading, refetch, isError: balanceError } = useReadContract({
    address: usdcFact?.address as `0x${string}` | undefined,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ARC_MAINNET_ID,
    query: { enabled: !!address && !!usdcFact && isOnArc },
  })

  const formattedBalance = balance != null
    ? Amount.fromRaw(balance, usdcDecimalsFor(ARC_MAINNET_ID)).toFixed(2)
    : null

  function copyAddress() {
    if (!address) return
    void navigator.clipboard.writeText(address).then(() => {
      setCopied('ok')
      setTimeout(() => setCopied('idle'), 1800)
    }).catch(() => {
      setCopied('failed')
      setTimeout(() => setCopied('idle'), 2500)
    })
  }

  function handleDisconnect() {
    setDisconnectError(null)
    try {
      disconnect()
    } catch (e: unknown) {
      setDisconnectError('Failed to disconnect. Please try again.')
      console.error('Disconnect error:', e)
    }
  }

  // Refresh balance every 30s when on Arc
  useEffect(() => {
    if (!address || !isOnArc) return
    const id = setInterval(() => void refetch(), 30_000)
    return () => clearInterval(id)
  }, [address, isOnArc, refetch])

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-10 max-w-lg mx-auto">

      {/* Page title */}
      <div className="mb-8">
        <h1 className="display-serif text-4xl text-[var(--ink)] mb-2 leading-tight">Wallet</h1>
        <p className="text-sm text-[var(--muted)]">Arc Mainnet &middot; USDC</p>
      </div>

      {/* ── Disconnected state ── */}
      {!isConnected && (
        <div className="card-elevated overflow-hidden">
          <div className="px-6 pt-10 pb-8 text-center">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-6"
              style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
            >
              <Wallet size={24} className="text-[var(--muted)]" />
            </div>
            <h2 className="display text-xl font-semibold text-[var(--ink)] mb-3">
              Connect your wallet
            </h2>
            <p className="text-sm text-[var(--muted)] mb-7 max-w-xs mx-auto leading-relaxed">
              A wallet is needed to authenticate your identity and access the free daily inference
              allowance. No transaction or gas fee is required.
            </p>
            <div className="flex justify-center">
              <ConnectKitButton />
            </div>
          </div>
          <div
            className="px-6 py-3 border-t border-[var(--border)] text-center"
            style={{ background: 'var(--surface-muted)' }}
          >
            <p className="text-[11px] text-[var(--subtle)]">
              Supports MetaMask, Coinbase Wallet, Rabby, and any WalletConnect-compatible wallet
            </p>
          </div>
        </div>
      )}

      {/* ── Connected state ── */}
      {isConnected && address && (
        <div className="space-y-3">

          {/* Network banner */}
          {!isOnArc ? (
            <div
              className="flex items-start gap-3 px-4 py-4 rounded-2xl"
              style={{ background: 'rgba(201,160,74,0.08)', border: '1px solid rgba(201,160,74,0.2)' }}
            >
              <AlertCircle size={15} className="mt-0.5 shrink-0" style={{ color: '#c9a04a' }} />
              <div className="flex-1">
                <p className="text-sm font-semibold text-[var(--ink)]">Wrong network</p>
                <p className="text-xs text-[var(--muted)] mt-0.5">
                  You are on chain {chainId}. Switch to {arcChain.name} to view your USDC balance.
                </p>
                <button
                  onClick={() => switchChain({ chainId: ARC_MAINNET_ID })}
                  disabled={isSwitching}
                  className="mt-3 px-4 py-1.5 text-xs rounded-full font-semibold transition-colors
                    disabled:opacity-50"
                  style={{ background: '#c9a04a', color: '#0c1a14' }}
                >
                  {isSwitching ? 'Switching…' : `Switch to ${arcChain.name}`}
                </button>
              </div>
            </div>
          ) : (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-full w-fit"
              style={{ background: 'rgba(138,171,122,0.10)', border: '1px solid rgba(138,171,122,0.2)' }}
            >
              <CheckCircle size={12} className="text-[var(--sage)]" />
              <span className="text-xs font-medium text-[var(--sage)]">
                Connected to {arcChain.name}
              </span>
            </div>
          )}

          {/* Address card */}
          <div className="card-elevated p-6">
            <p className="text-[10px] text-[var(--subtle)] uppercase tracking-widest font-medium mb-4">
              Wallet Address
            </p>
            <div className="flex items-center gap-2 mb-2">
              <p className="mono text-lg font-medium text-[var(--ink)] tabular-nums">
                {formatAddress(address)}
              </p>
              <button
                onClick={copyAddress}
                className="p-1.5 rounded-lg hover:bg-[var(--surface-strong)] text-[var(--subtle)]
                  hover:text-[var(--ink)] transition-colors shrink-0"
                aria-label={
                  copied === 'ok' ? 'Copied!' :
                  copied === 'failed' ? 'Copy unavailable' :
                  'Copy address'
                }
                title={
                  copied === 'ok' ? 'Copied!' :
                  copied === 'failed' ? 'Copy unavailable — copy the address below manually' :
                  'Copy address'
                }
              >
                {copied === 'ok'
                  ? <Check size={13} className="text-[var(--sage)]" />
                  : copied === 'failed'
                    ? <Copy size={13} className="text-[var(--danger)]" />
                    : <Copy size={13} />}
              </button>
            </div>
            <p className="mono text-[11px] text-[var(--subtle)] break-all tabular-nums leading-relaxed">
              {address}
            </p>
            <a
              href={buildAddressExplorerUrl(ARC_MAINNET_ID, address)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 flex items-center gap-1.5 text-xs text-[var(--muted)]
                hover:text-[var(--ink)] transition-colors w-fit"
            >
              View on Arc Explorer <ExternalLink size={11} />
            </a>
          </div>

          {/* USDC balance card */}
          <div className="card-elevated p-6">
            <div className="flex items-center justify-between mb-5">
              <p className="text-[10px] text-[var(--subtle)] uppercase tracking-widest font-medium">
                USDC Balance
              </p>
              {isOnArc && (
                <button
                  onClick={() => void refetch()}
                  className="text-[var(--subtle)] hover:text-[var(--ink)] p-1 transition-colors rounded-md
                    hover:bg-[var(--surface-strong)]"
                  aria-label="Refresh balance"
                >
                  <RefreshCw size={13} />
                </button>
              )}
            </div>

            {!isOnArc ? (
              <p className="text-sm text-[var(--muted)]">
                Switch to Arc Mainnet to view your USDC balance.
              </p>
            ) : balanceLoading ? (
              <p className="display text-3xl text-[var(--subtle)] tabular-nums font-semibold">…</p>
            ) : balanceError ? (
              <p className="text-sm text-[var(--muted)]">
                Unable to fetch balance — check your connection and try refreshing.
              </p>
            ) : formattedBalance != null ? (
              <p className="display text-4xl font-semibold text-[var(--ink)] tabular-nums tracking-tight">
                {formattedBalance}
                <span className="text-base text-[var(--muted)] ml-2 font-normal tracking-normal">
                  USDC
                </span>
              </p>
            ) : (
              <p className="text-sm text-[var(--muted)]">Balance unavailable</p>
            )}

            {usdcFact && isOnArc && (
              <div className="mt-5 pt-4 border-t border-[var(--border)]">
                <p className="text-[10px] text-[var(--subtle)] mb-1.5">USDC Contract (Arc Mainnet)</p>
                <p className="mono text-[11px] text-[var(--subtle)] break-all tabular-nums">
                  {usdcFact.address}
                </p>
              </div>
            )}
          </div>

          {/* Network details card */}
          <div className="card p-5">
            <p className="text-[10px] text-[var(--subtle)] uppercase tracking-widest font-medium mb-4">
              Network
            </p>
            <div className="space-y-2.5">
              {([
                ['Chain',     arcChain.name],
                ['Chain ID',  String(ARC_MAINNET_ID)],
                ['Gas token', 'USDC (native)'],
                ['RPC',       arcChain.rpcUrls[0]],
                ['Explorer',  arcChain.explorerBase],
              ] as const).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4">
                  <span className="text-xs text-[var(--subtle)] shrink-0">{label}</span>
                  <span className="mono text-[var(--muted)] text-right break-all tabular-nums text-xs">
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Payment architecture note */}
          <div className="card p-5">
            <p className="text-[10px] text-[var(--subtle)] uppercase tracking-widest font-medium mb-2">
              Payment Architecture
            </p>
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              InferMesh uses your wallet address for identity and free-tier enforcement.
              Current sessions use a server-side free allowance.
              A future USDC payment contract will allow per-request deductions from an onchain deposit.
            </p>
            <div className="mt-3 px-3 py-2.5 rounded-xl" style={{ background: 'rgba(201,160,74,0.05)', border: '1px solid rgba(201,160,74,0.15)' }}>
              <p className="text-xs font-medium" style={{ color: '#c9a04a' }}>Pending deployment</p>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                The escrow contract requires explicit approval before deployment.
              </p>
            </div>
          </div>

          {/* Disconnect error */}
          {disconnectError && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-xl"
              style={{ background: 'rgba(224,123,106,0.08)', border: '1px solid rgba(224,123,106,0.2)' }}>
              <ShieldAlert size={14} className="text-[var(--danger)] shrink-0" />
              <p className="text-sm text-[var(--danger)]">{disconnectError}</p>
            </div>
          )}

          {/* Disconnect button */}
          <button
            onClick={handleDisconnect}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl
              border border-[var(--border)] text-sm text-[var(--muted)] hover:text-[var(--danger)]
              hover:border-[var(--danger)] transition-all duration-150 font-medium"
            style={{ background: 'transparent' }}
          >
            <LogOut size={14} />
            Disconnect wallet
          </button>

        </div>
      )}
    </div>
  )
}
