import { useEffect, useState, useMemo } from 'react'
import {
  Search, AlertCircle, Cpu, ExternalLink, ChevronRight,
  Loader2, SlidersHorizontal, X, Plus, Minus, BarChart2,
  CheckCircle, Info, Calendar,
} from 'lucide-react'
import { api, OrbioModel } from '../lib/api'
import {
  modelDisplayName,
  modelProvider,
  isVariantModel,
  variantLabel,
  formatContextLength,
  getCapabilityBadges,
  formatModelDate,
  getModelPricing,
  type PriceDisplay,
} from '../lib/utils'

interface Props {
  onSelectModel: (modelId: string) => void
}

// Capability filters derived from actual API data
const CAPABILITY_FILTERS = [
  { key: 'vision', label: 'Vision' },
  { key: 'tools', label: 'Tools' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'streaming', label: 'Streaming' },
  { key: 'structured output', label: 'Structured output' },
  { key: 'audio', label: 'Audio' },
]

const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest' },
  { key: 'price_asc', label: 'Price: low to high' },
  { key: 'price_desc', label: 'Price: high to low' },
  { key: 'context_desc', label: 'Context: largest' },
]

type SortKey = 'newest' | 'price_asc' | 'price_desc' | 'context_desc'
type Tab = 'all' | 'base' | 'free'

// Maximum models to show in the compare drawer
const MAX_COMPARE = 3

export default function Marketplace({ onSelectModel }: Props) {
  const [models, setModels] = useState<OrbioModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [capFilter, setCapFilter] = useState<string[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('newest')
  const [tab, setTab] = useState<Tab>('base')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [showCompare, setShowCompare] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.models()
      .then((res) => {
        if (!cancelled) { setModels(res.data ?? []); setLoading(false) }
      })
      .catch((e: unknown) => { if (!cancelled) { setError(String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  // Memoised filter + sort
  const filtered = useMemo(() => {
    let list = models

    // Tab filter
    if (tab === 'base') list = list.filter((m) => !isVariantModel(m.id))
    if (tab === 'free') list = list.filter((m) => {
      const p = getModelPricing(m.pricing)
      return p.isFree
    })

    // Text search
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (m) =>
          m.id.toLowerCase().includes(q) ||
          (m.name ?? '').toLowerCase().includes(q) ||
          (m.owned_by ?? '').toLowerCase().includes(q),
      )
    }

    // Capability filter
    if (capFilter.length > 0) {
      list = list.filter((m) => {
        const caps = getCapabilityBadges(m)
        return capFilter.every((c) => caps.includes(c))
      })
    }

    // Sort
    list = [...list].sort((a, b) => {
      if (sortKey === 'newest') {
        return (b.created ?? 0) - (a.created ?? 0)
      }
      if (sortKey === 'context_desc') {
        return (b.context_length ?? 0) - (a.context_length ?? 0)
      }
      if (sortKey === 'price_asc' || sortKey === 'price_desc') {
        const outA = getModelPricing(a.pricing).output
        const outB = getModelPricing(b.pricing).output
        // Only 'paid' has a real perMillion value.
        // Free models sort to the cheapest end; invalid/unavailable sort to the unknown end.
        const sentinelEnd = sortKey === 'price_asc' ? Infinity : -Infinity
        const sentinelFree = sortKey === 'price_asc' ? 0 : Infinity
        const pa = outA.status === 'paid'
          ? (outA.perMillion ?? sentinelEnd)
          : outA.status === 'free' ? sentinelFree : sentinelEnd
        const pb = outB.status === 'paid'
          ? (outB.perMillion ?? sentinelEnd)
          : outB.status === 'free' ? sentinelFree : sentinelEnd
        return sortKey === 'price_asc' ? pa - pb : pb - pa
      }
      return 0
    })

    return list
  }, [models, search, capFilter, sortKey, tab])

  const selectedModel = models.find((m) => m.id === selectedId)
  const compareModels = compareIds.map((id) => models.find((m) => m.id === id)).filter(Boolean) as OrbioModel[]

  function toggleCap(cap: string) {
    setCapFilter((prev) => prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap])
  }

  function toggleCompare(id: string) {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_COMPARE) return prev // silently ignore
      return [...prev, id]
    })
  }

  const baseCount = useMemo(() => models.filter((m) => !isVariantModel(m.id)).length, [models])
  const freeCount = useMemo(() => models.filter((m) => getModelPricing(m.pricing).isFree).length, [models])

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-6xl mx-auto">

      {/* Header */}
      <div className="mb-5">
        <h1 className="display text-2xl font-semibold text-[var(--ink)] tracking-tight">Explore Models</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          {loading
            ? 'Loading catalogue...'
            : `${models.length} models · ${baseCount} base · ${freeCount} free · via Orbio gateway`}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 p-1 bg-[var(--surface)] border border-[var(--border)] rounded-xl w-fit">
        {([
          { key: 'all' as Tab, label: 'All', count: models.length },
          { key: 'base' as Tab, label: 'Base models', count: baseCount },
          { key: 'free' as Tab, label: 'Free', count: freeCount },
        ]).map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5
              ${tab === key
                ? 'bg-[var(--surface-strong)] text-[var(--ink)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
          >
            {label}
            <span className={`tabular-nums text-[10px] ${tab === key ? 'text-[var(--subtle)]' : 'text-[var(--subtle)]/60'}`}>
              {count}
            </span>
          </button>
        ))}
      </div>

      {/* Search + filter + sort bar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="flex-1 relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--subtle)] pointer-events-none" />
          <input
            type="search"
            placeholder="Search models or providers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 bg-[var(--surface)] border border-[var(--border)]
              rounded-xl text-sm text-[var(--ink)] placeholder:text-[var(--subtle)]
              focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)] focus:border-[var(--border-strong)]"
          />
        </div>
        <div className="flex gap-2 shrink-0">
          {/* Sort */}
          <div className="relative">
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="h-full appearance-none pl-3 pr-8 py-2.5 bg-[var(--surface)] border border-[var(--border)]
                rounded-xl text-sm text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer
                focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key} className="bg-[var(--surface-muted)]">{o.label}</option>
              ))}
            </select>
            <ChevronRight size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 rotate-90 text-[var(--subtle)] pointer-events-none" />
          </div>
          {/* Filters toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors whitespace-nowrap
              ${showFilters || capFilter.length > 0
                ? 'border-[var(--border-strong)] bg-[var(--surface-strong)] text-[var(--sage)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
          >
            <SlidersHorizontal size={14} />
            <span className="hidden sm:inline">Filters</span>
            {capFilter.length > 0 && (
              <span className="bg-[var(--sage)] text-[var(--bg)] text-[10px] w-4 h-4 rounded-full flex items-center justify-center">
                {capFilter.length}
              </span>
            )}
          </button>
          {/* Compare button */}
          {compareIds.length > 0 && (
            <button
              onClick={() => setShowCompare(true)}
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--border-strong)]
                bg-[var(--surface-strong)] text-[var(--sage)] text-sm font-medium whitespace-nowrap"
            >
              <BarChart2 size={14} />
              <span className="hidden sm:inline">Compare</span>
              <span className="bg-[var(--sage)] text-[var(--bg)] text-[10px] w-4 h-4 rounded-full flex items-center justify-center">
                {compareIds.length}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Capability filters panel */}
      {showFilters && (
        <div className="mb-4 p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <p className="text-xs text-[var(--subtle)] uppercase tracking-wider mb-3 font-medium">
            Capabilities
          </p>
          <div className="flex flex-wrap gap-2">
            {CAPABILITY_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => toggleCap(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                  ${capFilter.includes(key)
                    ? 'bg-[var(--surface-strong)] text-[var(--sage)] border border-[var(--border-strong)]'
                    : 'bg-[var(--surface-muted)] text-[var(--muted)] border border-[var(--border)] hover:text-[var(--ink)]'
                  }`}
              >
                {label}
              </button>
            ))}
            {capFilter.length > 0 && (
              <button
                onClick={() => setCapFilter([])}
                className="px-3 py-1.5 rounded-lg text-xs text-[var(--subtle)] hover:text-[var(--ink)] flex items-center gap-1"
              >
                <X size={11} /> Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="mb-4 flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
          <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-red-400 font-medium">Failed to load models</p>
            <p className="text-xs text-red-400/70 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20 gap-3 text-[var(--muted)]">
          <Loader2 size={18} className="animate-spin text-[var(--sage)]" />
          <span className="text-sm">Loading catalogue...</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div className="py-16 text-center border border-dashed border-[var(--border)] rounded-xl">
          <Cpu size={24} className="text-[var(--subtle)] mx-auto mb-3" />
          <p className="text-sm text-[var(--muted)]">No models match your filters</p>
          <button
            onClick={() => { setSearch(''); setCapFilter([]) }}
            className="mt-3 text-xs text-[var(--sage)] hover:text-[var(--ink-2)]"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Main content: list + detail panel */}
      {!loading && filtered.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-5">
          {/* Model list */}
          <div className={selectedModel ? 'lg:col-span-3' : 'lg:col-span-5'}>
            <div className="border border-[var(--border)] rounded-xl overflow-hidden">
              {filtered.slice(0, 200).map((model, i) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  isSelected={selectedId === model.id}
                  isCompared={compareIds.includes(model.id)}
                  isLast={i === Math.min(filtered.length, 200) - 1}
                  onSelect={() => setSelectedId(model.id === selectedId ? null : model.id)}
                  onToggleCompare={() => toggleCompare(model.id)}
                  compareDisabled={compareIds.length >= MAX_COMPARE && !compareIds.includes(model.id)}
                />
              ))}
            </div>
            {filtered.length > 200 && (
              <p className="text-xs text-[var(--subtle)] text-center mt-3 pb-2">
                Showing first 200 of {filtered.length} results — refine your search to see more
              </p>
            )}
          </div>

          {/* Detail panel */}
          {selectedModel && (
            <div className="lg:col-span-2">
              <DetailPanel
                model={selectedModel}
                onClose={() => setSelectedId(null)}
                onUseInPlayground={onSelectModel}
                isCompared={compareIds.includes(selectedModel.id)}
                onToggleCompare={() => toggleCompare(selectedModel.id)}
                compareDisabled={compareIds.length >= MAX_COMPARE && !compareIds.includes(selectedModel.id)}
              />
            </div>
          )}
        </div>
      )}

      {/* Compare drawer */}
      {showCompare && compareModels.length > 0 && (
        <CompareDrawer
          models={compareModels}
          onClose={() => setShowCompare(false)}
          onRemove={(id) => setCompareIds((prev) => prev.filter((x) => x !== id))}
          onUseInPlayground={(id) => { onSelectModel(id); setShowCompare(false) }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ModelRow
// ---------------------------------------------------------------------------

function ModelRow({
  model, isSelected, isCompared, isLast, onSelect, onToggleCompare, compareDisabled,
}: {
  model: OrbioModel
  isSelected: boolean
  isCompared: boolean
  isLast: boolean
  onSelect: () => void
  onToggleCompare: () => void
  compareDisabled: boolean
}) {
  const pricing = getModelPricing(model.pricing)
  const caps = getCapabilityBadges(model)
  const variant = variantLabel(model.id)
  const displayName = modelDisplayName(model)
  const provider = modelProvider(model)

  return (
    <div
      className={`group flex items-stretch transition-colors
        ${!isLast ? 'border-b border-[var(--border)]' : ''}
        ${isSelected ? 'bg-[var(--surface)]' : 'hover:bg-[var(--surface-strong)]'}
      `}
    >
      {/* Main clickable area */}
      <button
        onClick={onSelect}
        className="flex-1 min-w-0 flex items-start gap-3 px-4 py-3.5 text-left"
      >
        {/* Provider icon */}
        <div className="w-8 h-8 rounded-lg bg-[var(--surface-muted)] flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-xs font-semibold text-[var(--muted)] uppercase">
            {provider.slice(0, 2)}
          </span>
        </div>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-[var(--ink)] leading-tight">
              {displayName}
            </p>
            {variant && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium
                bg-[var(--surface-muted)] text-[var(--subtle)] border border-[var(--border)]">
                {variant}
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--subtle)] mt-0.5 truncate">
            {provider}
            {model.context_length ? ` · ${formatContextLength(model.context_length)}` : ''}
          </p>
          {/* Capability chips — visible on wider screens */}
          {caps.length > 0 && (
            <div className="hidden sm:flex flex-wrap gap-1 mt-1.5">
              {caps.slice(0, 4).map((c) => (
                <span key={c} className="px-1.5 py-0.5 rounded text-[9px] font-medium
                  bg-[var(--surface-muted)] text-[var(--subtle)] border border-[var(--border)]">
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Pricing column — both directions, clearly labelled */}
        <div className="text-right shrink-0 ml-2 space-y-1.5 min-w-[72px]">
          <PriceBadge price={pricing.input} size="sm" label="input" />
          <PriceBadge price={pricing.output} size="sm" label="output" />
        </div>

        <ChevronRight
          size={14}
          className={`text-[var(--subtle)] transition-transform shrink-0 self-center
            ${isSelected ? 'rotate-90 text-[var(--sage)]' : 'group-hover:text-[var(--muted)]'}`}
        />
      </button>

      {/* Compare toggle — shown on hover or when already compared */}
      <button
        onClick={onToggleCompare}
        disabled={compareDisabled}
        title={isCompared ? 'Remove from comparison' : 'Add to compare'}
        className={`px-2 flex items-center justify-center border-l border-[var(--border)] transition-colors
          ${isCompared
            ? 'text-[var(--sage)] bg-[var(--surface)]'
            : 'text-[var(--subtle)] opacity-0 group-hover:opacity-100 hover:text-[var(--ink)]'
          }
          disabled:opacity-30 disabled:cursor-not-allowed`}
      >
        {isCompared ? <Minus size={13} /> : <Plus size={13} />}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PriceBadge
// ---------------------------------------------------------------------------

function PriceBadge({
  price, size = 'md', label,
}: { price: PriceDisplay; size?: 'sm' | 'md'; label?: string }) {
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm'
  const subSize = size === 'sm' ? 'text-[10px]' : 'text-xs'

  if (price.status === 'free') {
    return (
      <div>
        <span className={`${textSize} font-medium text-[var(--sage)] tabular-nums`}>Free</span>
        {label && <p className={`${subSize} text-[var(--subtle)]`}>{label}</p>}
      </div>
    )
  }

  if (price.status === 'paid' && price.label) {
    return (
      <div>
        <span className={`mono ${textSize} text-[var(--ink)] tabular-nums`}>{price.label}</span>
        {label && <p className={`${subSize} text-[var(--subtle)]`}>{label}</p>}
      </div>
    )
  }

  if (price.status === 'invalid') {
    // rawDebug is preserved internally; we never render the invalid value as a price.
    return (
      <div title={`Invalid source value: ${price.rawDebug ?? 'unknown'}`}>
        <span className={`${textSize} text-amber-500 italic`}>Unavailable</span>
        {label && <p className={`${subSize} text-[var(--subtle)]`}>{label}</p>}
      </div>
    )
  }

  // unavailable (field absent or empty)
  return (
    <div>
      <span className={`${textSize} text-[var(--subtle)] italic`}>Unavailable</span>
      {label && <p className={`${subSize} text-[var(--subtle)]`}>{label}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DetailPanel
// ---------------------------------------------------------------------------

function DetailPanel({
  model, onClose, onUseInPlayground, isCompared, onToggleCompare, compareDisabled,
}: {
  model: OrbioModel
  onClose: () => void
  onUseInPlayground: (id: string) => void
  isCompared: boolean
  onToggleCompare: () => void
  compareDisabled: boolean
}) {
  const pricing = getModelPricing(model.pricing)
  const caps = getCapabilityBadges(model)
  const provider = modelProvider(model)
  const displayName = modelDisplayName(model)
  const variant = variantLabel(model.id)

  return (
    <div className="sticky top-4 border border-[var(--border)] rounded-xl bg-[var(--surface)] overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 p-5 border-b border-[var(--border)]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <p className="text-xs text-[var(--subtle)] uppercase tracking-wider font-medium">{provider}</p>
            {variant && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--surface-muted)]
                text-[var(--subtle)] border border-[var(--border)]">
                {variant}
              </span>
            )}
          </div>
          <h3 className="display text-base font-semibold text-[var(--ink)] leading-snug">
            {displayName}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="text-[var(--subtle)] hover:text-[var(--ink)] shrink-0 mt-0.5 p-1 -mr-1 rounded-lg
            hover:bg-[var(--surface-strong)] transition-colors"
        >
          <X size={15} />
        </button>
      </div>

      {/* Body */}
      <div className="p-5 space-y-5">
        {/* Model ID */}
        <div>
          <p className="text-[10px] text-[var(--subtle)] uppercase tracking-wider font-medium mb-1.5">
            Model ID
          </p>
          <p className="mono text-xs text-[var(--ink)] break-all bg-[var(--surface-muted)]
            border border-[var(--border)] rounded-lg px-3 py-2 select-all">
            {model.id}
          </p>
        </div>

        {/* Pricing */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <p className="text-[10px] text-[var(--subtle)] uppercase tracking-wider font-medium">
              Pricing
            </p>
            <span className="text-[10px] text-[var(--subtle)]">· per 1M tokens</span>
            {pricing.hasOverrides && (
              <span className="flex items-center gap-0.5 text-[10px] text-amber-400" title="Tiered pricing: rates change above certain token thresholds">
                <Info size={9} /> tiered
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-[var(--surface-muted)] border border-[var(--border)] rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-[var(--subtle)] mb-1">Input</p>
              <PriceBadge price={pricing.input} size="md" />
            </div>
            <div className="bg-[var(--surface-muted)] border border-[var(--border)] rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-[var(--subtle)] mb-1">Output</p>
              <PriceBadge price={pricing.output} size="md" />
            </div>
          </div>
          {pricing.isFree && (
            <div className="flex items-center gap-1.5 mt-2 text-[10px] text-[var(--sage)]">
              <CheckCircle size={10} /> Confirmed free — Orbio reports $0.00 for both input and output
            </div>
          )}
          {(pricing.input.status === 'invalid' || pricing.output.status === 'invalid') && (
            <p className="mt-2 text-[10px] text-amber-500/90">
              Pricing unavailable — this model returns an invalid source value (e.g. a routing alias
              whose cost is only known at request time). Check Orbio for current rates.
            </p>
          )}
          {pricing.hasOverrides && (
            <p className="mt-2 text-[10px] text-amber-400/80">
              Tiered pricing applies: rates increase above a token threshold. Check Orbio for full details.
            </p>
          )}
        </div>

        {/* Specs */}
        <div className="space-y-2">
          {model.context_length && (
            <SpecRow label="Context window">
              <span className="mono text-xs text-[var(--ink)] tabular-nums">
                {model.context_length.toLocaleString()} tokens
              </span>
            </SpecRow>
          )}
          {model.top_provider?.max_completion_tokens && (
            <SpecRow label="Max output">
              <span className="mono text-xs text-[var(--ink)] tabular-nums">
                {model.top_provider.max_completion_tokens.toLocaleString()} tokens
              </span>
            </SpecRow>
          )}
          {model.architecture?.tokenizer && (
            <SpecRow label="Tokenizer">
              <span className="text-xs text-[var(--ink)]">{model.architecture.tokenizer}</span>
            </SpecRow>
          )}
          {model.architecture?.modality && (
            <SpecRow label="Modality">
              <span className="text-xs text-[var(--ink)] break-all">{model.architecture.modality}</span>
            </SpecRow>
          )}
          {model.created && (
            <SpecRow label="Listed">
              <span className="flex items-center gap-1 text-xs text-[var(--muted)]">
                <Calendar size={10} />
                {formatModelDate(model.created)}
              </span>
            </SpecRow>
          )}
        </div>

        {/* Capabilities */}
        {caps.length > 0 && (
          <div>
            <p className="text-[10px] text-[var(--subtle)] uppercase tracking-wider font-medium mb-2">
              Capabilities
            </p>
            <div className="flex flex-wrap gap-1.5">
              {caps.map((cap) => (
                <span key={cap}
                  className="px-2 py-1 rounded-md bg-[var(--surface-muted)] text-xs text-[var(--muted)]
                    border border-[var(--border)]">
                  {cap}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-5 pb-5 flex flex-col gap-2">
        <button
          onClick={() => onUseInPlayground(model.id)}
          className="btn-primary w-full justify-center text-sm rounded-xl"
        >
          Try in Playground
          <ExternalLink size={13} />
        </button>
        <button
          onClick={onToggleCompare}
          disabled={compareDisabled}
          className={`w-full py-2 rounded-lg text-sm font-medium transition-colors border flex items-center justify-center gap-2
            ${isCompared
              ? 'border-[var(--border-strong)] bg-[var(--surface-strong)] text-[var(--sage)] hover:bg-[var(--surface-strong)]'
              : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--ink)]'
            }
            disabled:opacity-30 disabled:cursor-not-allowed`}
        >
          {isCompared ? <><Minus size={13} /> Remove from compare</> : <><Plus size={13} /> Add to compare</>}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SpecRow
// ---------------------------------------------------------------------------

function SpecRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-[var(--border)]">
      <span className="text-xs text-[var(--subtle)] shrink-0 pt-0.5">{label}</span>
      <div className="text-right">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CompareDrawer
// ---------------------------------------------------------------------------

function CompareDrawer({
  models, onClose, onRemove, onUseInPlayground,
}: {
  models: OrbioModel[]
  onClose: () => void
  onRemove: (id: string) => void
  onUseInPlayground: (id: string) => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-4xl bg-[var(--surface-muted)] border border-[var(--border)] rounded-2xl overflow-hidden
        max-h-[90dvh] overflow-y-auto">

        {/* Drawer header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] sticky top-0 bg-[var(--surface-muted)] z-10">
          <div className="flex items-center gap-2">
            <BarChart2 size={16} className="text-[var(--sage)]" />
            <h2 className="display text-base font-semibold text-[var(--ink)]">
              Compare Models
            </h2>
            <span className="text-xs text-[var(--subtle)]">({models.length} selected)</span>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--subtle)] hover:text-[var(--ink)] p-1 rounded-lg hover:bg-[var(--surface-strong)]"
          >
            <X size={16} />
          </button>
        </div>

        {/* Compare table */}
        <div className="p-6">
          {/* Column headers */}
          <div
            className="grid gap-4 mb-4"
            style={{ gridTemplateColumns: `160px repeat(${models.length}, 1fr)` }}
          >
            <div />
            {models.map((m) => (
              <div key={m.id} className="relative">
                <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
                  <div className="w-8 h-8 rounded-lg bg-[var(--surface-muted)] flex items-center justify-center mb-2">
                    <span className="text-xs font-semibold text-[var(--muted)] uppercase">
                      {modelProvider(m).slice(0, 2)}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-[var(--ink)] leading-snug mb-0.5">
                    {modelDisplayName(m)}
                  </p>
                  <p className="text-xs text-[var(--subtle)] truncate">{modelProvider(m)}</p>
                  <button
                    onClick={() => onRemove(m.id)}
                    className="absolute top-2 right-2 text-[var(--subtle)] hover:text-red-400 p-0.5 rounded"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Comparison rows */}
          {[
            {
              label: 'Model ID',
              render: (m: OrbioModel) => (
                <span className="mono text-xs text-[var(--muted)] break-all">{m.id}</span>
              ),
            },
            {
              label: 'Input price',
              render: (m: OrbioModel) => <PriceBadge price={getModelPricing(m.pricing).input} size="sm" />,
            },
            {
              label: 'Output price',
              render: (m: OrbioModel) => <PriceBadge price={getModelPricing(m.pricing).output} size="sm" />,
            },
            {
              label: 'Context window',
              render: (m: OrbioModel) => (
                <span className="mono text-xs text-[var(--ink)] tabular-nums">
                  {m.context_length ? m.context_length.toLocaleString() + ' tok' : '—'}
                </span>
              ),
            },
            {
              label: 'Modality',
              render: (m: OrbioModel) => (
                <span className="text-xs text-[var(--muted)]">
                  {m.architecture?.modality ?? '—'}
                </span>
              ),
            },
            {
              label: 'Capabilities',
              render: (m: OrbioModel) => {
                const caps = getCapabilityBadges(m)
                return caps.length > 0
                  ? (
                    <div className="flex flex-wrap gap-1">
                      {caps.map((c) => (
                        <span key={c} className="px-1.5 py-0.5 rounded text-[10px]
                          bg-[var(--surface-muted)] text-[var(--subtle)] border border-[var(--border)]">
                          {c}
                        </span>
                      ))}
                    </div>
                  )
                  : <span className="text-xs text-[var(--subtle)]">—</span>
              },
            },
            {
              label: 'Tiered pricing',
              render: (m: OrbioModel) => {
                const hasT = getModelPricing(m.pricing).hasOverrides
                return hasT
                  ? <span className="text-xs text-amber-400">Yes</span>
                  : <span className="text-xs text-[var(--subtle)]">No</span>
              },
            },
            {
              label: 'Listed',
              render: (m: OrbioModel) => (
                <span className="text-xs text-[var(--muted)]">{formatModelDate(m.created)}</span>
              ),
            },
          ].map(({ label, render }) => (
            <div
              key={label}
              className="grid gap-4 py-3 border-t border-[var(--border)] items-start"
              style={{ gridTemplateColumns: `160px repeat(${models.length}, 1fr)` }}
            >
              <div className="text-xs text-[var(--subtle)] pt-0.5 font-medium">{label}</div>
              {models.map((m) => (
                <div key={m.id}>{render(m)}</div>
              ))}
            </div>
          ))}

          {/* Action row */}
          <div
            className="grid gap-4 pt-4 mt-1 border-t border-[var(--border)]"
            style={{ gridTemplateColumns: `160px repeat(${models.length}, 1fr)` }}
          >
            <div />
            {models.map((m) => (
              <button
                key={m.id}
                onClick={() => onUseInPlayground(m.id)}
                className="btn-primary w-full justify-center text-xs rounded-lg"
              >
                Try in Playground <ExternalLink size={11} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
