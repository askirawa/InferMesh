import { useEffect, useState } from 'react'
import {
  Clock, CheckCircle, XCircle, Loader2, AlertCircle,
  ChevronDown, ChevronRight, User, Hash,
} from 'lucide-react'
import { api, UsageRecord } from '../lib/api'
import { formatRelativeTime, formatLatency, formatTokens, formatCost, modelDisplayName, modelProvider } from '../lib/utils'
import { useAccount } from 'wagmi'

const PAGE_SIZE = 20

export default function UsageHistory() {
  const { address } = useAccount()
  const [records, setRecords] = useState<UsageRecord[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, UsageRecord>>({})
  const [detailLoading, setDetailLoading] = useState<string | null>(null)
  const [filterWallet, setFilterWallet] = useState(false)

  const wallet = filterWallet && address ? address : undefined

  useEffect(() => {
    let cancelled = false
    api.usage({ limit: PAGE_SIZE, offset: 0, wallet })
      .then((res) => {
        if (cancelled) return
        setOffset(0)
        setRecords(res.records)
        setTotal(res.total)
        setLoading(false)
      })
      .catch((e: unknown) => { if (!cancelled) { setError(String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [wallet])

  function loadPage(newOffset: number) {
    setLoading(true)
    setOffset(newOffset)
    api.usage({ limit: PAGE_SIZE, offset: newOffset, wallet })
      .then((res) => {
        setRecords(res.records)
        setTotal(res.total)
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false))
  }

  function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setExpandedId(id)
    if (!detail[id]) {
      setDetailLoading(id)
      api.usageRecord(id)
        .then((r) => setDetail((prev) => ({ ...prev, [id]: r })))
        .catch(() => null)
        .finally(() => setDetailLoading(null))
    }
  }

  const pages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE)

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="display text-2xl font-semibold text-[var(--ink)] tracking-tight">Usage History</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            {total > 0 ? `${total} request${total !== 1 ? 's' : ''} recorded` : 'All inference requests'}
          </p>
        </div>
        {address && (
          <button
            onClick={() => setFilterWallet(!filterWallet)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors shrink-0
              ${filterWallet
                ? 'border-[var(--border-strong)] bg-[var(--surface-strong)] text-[var(--sage)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
          >
            <User size={13} />
            Mine only
          </button>
        )}
      </div>

      {/* Legend */}
      <div className="mb-4 flex items-center gap-4 text-xs text-[var(--subtle)]">
        <span className="flex items-center gap-1.5">
          <CheckCircle size={11} className="text-[var(--sage)]" /> Success
        </span>
        <span className="flex items-center gap-1.5">
          <XCircle size={11} className="text-red-400" /> Error
        </span>
        <span className="flex items-center gap-1.5">
          <Clock size={11} /> Pending
        </span>
        <span className="text-[var(--subtle)]">
          Costs are provider-reported. — means not reported.
        </span>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <AlertCircle size={14} className="text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16 gap-2 text-[var(--muted)]">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm">Loading records...</span>
        </div>
      )}

      {!loading && records.length === 0 && (
        <div className="py-16 text-center border border-dashed border-[var(--border)] rounded-xl">
          <Clock size={24} className="text-[var(--subtle)] mx-auto mb-3" />
          <p className="text-sm text-[var(--muted)]">No usage records yet</p>
          <p className="text-xs text-[var(--subtle)] mt-1">
            Inference requests appear here as you run them
          </p>
        </div>
      )}

      {!loading && records.length > 0 && (
        <div className="border border-[var(--border)] rounded-xl overflow-hidden mb-4">
          {/* Table header */}
          <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_5rem_5rem_4rem_4rem] gap-3 px-4 py-2
            bg-[var(--surface-muted)] border-b border-[var(--border)] text-[10px] text-[var(--subtle)]
            uppercase tracking-wider font-medium">
            <div />
            <div>Model</div>
            <div className="text-right hidden sm:block">Tokens</div>
            <div className="text-right hidden sm:block">Cost</div>
            <div className="text-right">Latency</div>
            <div className="text-right">When</div>
          </div>

          {records.map((r, i) => (
            <div key={r.id}>
              <button
                onClick={() => toggleExpand(r.id)}
                className={`w-full grid grid-cols-[1.5rem_minmax(0,1fr)_5rem_5rem_4rem_4rem] gap-3 px-4 py-3 text-left
                  transition-colors
                  ${i < records.length - 1 ? 'border-b border-[var(--border)]' : ''}
                  ${expandedId === r.id ? 'bg-[var(--surface-strong)]' : 'hover:bg-[var(--surface-strong)]'}
                `}
              >
                <div className="flex items-center justify-center pt-0.5">
                  {r.status === 'success'
                    ? <CheckCircle size={13} className="text-[var(--sage)]" />
                    : r.status === 'error'
                    ? <XCircle size={13} className="text-red-400" />
                    : <Clock size={13} className="text-[var(--subtle)]" />
                  }
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--ink)] truncate">
                    {modelDisplayName(r.model_id)}
                  </p>
                  <p className="text-xs text-[var(--subtle)] truncate">
                    {modelProvider(r.model_id)}
                  </p>
                </div>
                <div className="mono text-xs text-[var(--muted)] text-right tabular-nums hidden sm:block self-center">
                  {formatTokens((r.input_tokens ?? 0) + (r.output_tokens ?? 0))}
                </div>
                <div className="mono text-xs text-[var(--muted)] text-right tabular-nums hidden sm:block self-center">
                  {formatCost(r.cost_usd)}
                </div>
                <div className="mono text-xs text-[var(--muted)] text-right tabular-nums self-center">
                  {formatLatency(r.latency_ms)}
                </div>
                <div className="text-xs text-[var(--subtle)] text-right self-center">
                  {formatRelativeTime(r.created_at)}
                </div>
              </button>

              {/* Expanded detail */}
              {expandedId === r.id && (
                <div className="px-4 py-4 border-b border-[var(--border)] bg-[var(--surface)] space-y-3">
                  {detailLoading === r.id ? (
                    <div className="flex items-center gap-2 text-[var(--muted)] text-sm">
                      <Loader2 size={13} className="animate-spin" />
                      Loading detail...
                    </div>
                  ) : detail[r.id] ? (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <DetailCell label="Request ID">
                          <span className="mono text-xs text-[var(--ink)] tabular-nums">{r.id}</span>
                        </DetailCell>
                        <DetailCell label="Input tokens">
                          <span className="mono text-xs text-[var(--ink)] tabular-nums">
                            {formatTokens(r.input_tokens)}
                          </span>
                        </DetailCell>
                        <DetailCell label="Output tokens">
                          <span className="mono text-xs text-[var(--ink)] tabular-nums">
                            {formatTokens(r.output_tokens)}
                          </span>
                        </DetailCell>
                        <DetailCell label="Cost">
                          <span className="mono text-xs text-[var(--ink)] tabular-nums">
                            {formatCost(r.cost_usd)}
                            {r.cost_usd == null && (
                              <span className="text-[var(--subtle)] ml-1">(not reported)</span>
                            )}
                          </span>
                        </DetailCell>
                      </div>

                      {detail[r.id].prompt && (
                        <div>
                          <p className="text-[10px] text-[var(--subtle)] uppercase tracking-wider mb-1.5">Prompt</p>
                          <div className="px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)]">
                            <p className="text-sm text-[var(--muted)] leading-relaxed whitespace-pre-wrap line-clamp-4">
                              {detail[r.id].prompt}
                            </p>
                          </div>
                        </div>
                      )}

                      {detail[r.id].response && (
                        <div>
                          <p className="text-[10px] text-[var(--subtle)] uppercase tracking-wider mb-1.5">Response</p>
                          <div className="px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)]">
                            <p className="text-sm text-[var(--muted)] leading-relaxed whitespace-pre-wrap line-clamp-6">
                              {detail[r.id].response}
                            </p>
                          </div>
                        </div>
                      )}

                      {detail[r.id].error && (
                        <div className="flex items-start gap-2 text-sm text-red-400">
                          <AlertCircle size={13} className="mt-0.5 shrink-0" />
                          <span>{detail[r.id].error}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <DetailCell label="Request ID">
                        <span className="mono text-xs text-[var(--ink)] tabular-nums">{r.id}</span>
                      </DetailCell>
                      <DetailCell label="Tokens">
                        <span className="mono text-xs text-[var(--ink)] tabular-nums">
                          <Hash size={11} className="inline mr-1" />
                          {formatTokens(r.input_tokens)} / {formatTokens(r.output_tokens)}
                        </span>
                      </DetailCell>
                    </div>
                  )}
                  <button
                    onClick={() => toggleExpand(r.id)}
                    className="flex items-center gap-1 text-xs text-[var(--subtle)] hover:text-[var(--ink)]"
                  >
                    <ChevronDown size={12} className="rotate-180" /> Collapse
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <button
            disabled={currentPage === 0 || loading}
            onClick={() => loadPage(Math.max(0, offset - PAGE_SIZE))}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--border)]
              bg-[var(--surface)] text-sm text-[var(--muted)] hover:text-[var(--ink)]
              disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight size={14} className="rotate-180" /> Previous
          </button>
          <span className="text-xs text-[var(--subtle)] tabular-nums">
            Page {currentPage + 1} of {pages}
          </span>
          <button
            disabled={currentPage >= pages - 1 || loading}
            onClick={() => loadPage(offset + PAGE_SIZE)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--border)]
              bg-[var(--surface)] text-sm text-[var(--muted)] hover:text-[var(--ink)]
              disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

function DetailCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="p-3 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)]">
      <p className="text-[10px] text-[var(--subtle)] uppercase tracking-wider mb-1">{label}</p>
      {children}
    </div>
  )
}
