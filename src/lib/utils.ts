import type { OrbioModel, OrbioModelPricing } from './api'

export function formatAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return new Date(timestamp).toLocaleDateString()
}

export function formatLatency(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatTokens(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatCost(usd: number | null): string {
  if (usd == null) return '—'
  if (usd === 0) return '$0.00'
  if (usd < 0.0001) return '<$0.0001'
  return `$${usd.toFixed(4)}`
}

// ---------------------------------------------------------------------------
// Pricing helpers — all values are per-token string decimals from Orbio.
// The display unit is per 1 million tokens.
// ---------------------------------------------------------------------------

/** Pricing status for a single direction (input or output) */
export type PriceStatus = 'free' | 'paid' | 'unavailable' | 'invalid'

export interface PriceDisplay {
  status: PriceStatus
  /** Human-readable amount, e.g. "$1.50 / 1M tokens" — only when status is 'paid' */
  label?: string
  /** Raw per-million USD number — only when status is 'paid' */
  perMillion?: number
  /**
   * Preserved raw source value for debugging when status is 'invalid'.
   * Never rendered to the user as a price — only used for internal diagnostics.
   */
  rawDebug?: string
}

/**
 * Parse a single pricing field from the Orbio API response.
 *
 * Rules (in order):
 *   1. Absent / null / empty string       → 'unavailable'
 *   2. Not parseable as a number           → 'invalid'  (rawDebug preserved)
 *   3. NaN after parseFloat               → 'invalid'  (rawDebug preserved)
 *   4. Negative number (e.g. Orbio "-1"
 *      sentinel for dynamic-routing)      → 'invalid'  (rawDebug preserved)
 *   5. Infinite number                    → 'invalid'  (rawDebug preserved)
 *   6. Exactly zero                       → 'free'
 *   7. Positive finite number             → 'paid', formatted per 1M tokens
 *
 * Note on "-1": Orbio uses "-1" as a sentinel on router/alias models whose
 * per-request price is only known at execution time (e.g. openrouter/auto).
 * It is NOT a valid inference price and must never be shown as one.
 */
export function parsePriceField(raw: string | number | undefined | null): PriceDisplay {
  // 1. Absent
  if (raw === undefined || raw === null || raw === '') {
    return { status: 'unavailable' }
  }

  const rawStr = String(raw)
  const n = typeof raw === 'number' ? raw : parseFloat(rawStr)

  // 2+3. Not a number
  if (isNaN(n)) {
    return { status: 'invalid', rawDebug: rawStr }
  }

  // 4. Negative — includes Orbio's "-1" dynamic-routing sentinel
  if (n < 0) {
    return { status: 'invalid', rawDebug: rawStr }
  }

  // 5. Infinite
  if (!isFinite(n)) {
    return { status: 'invalid', rawDebug: rawStr }
  }

  // 6. Genuinely free
  if (n === 0) {
    return { status: 'free', label: 'Free' }
  }

  // 7. Paid — format per 1M tokens
  const perM = n * 1_000_000
  const label = perM < 0.01
    ? `$${perM.toFixed(4)} / 1M tok`
    : `$${perM.toFixed(2)} / 1M tok`
  return { status: 'paid', label, perMillion: perM }
}

/** Full pricing summary for a model */
export interface ModelPricingSummary {
  input: PriceDisplay
  output: PriceDisplay
  hasOverrides: boolean
  /** True when both input AND output are genuinely free ($0) */
  isFree: boolean
}

export function getModelPricing(pricing: OrbioModelPricing | undefined): ModelPricingSummary {
  if (!pricing) {
    return {
      input: { status: 'unavailable' },
      output: { status: 'unavailable' },
      hasOverrides: false,
      isFree: false,
    }
  }
  const input = parsePriceField(pricing.prompt)
  const output = parsePriceField(pricing.completion)
  // Only mark genuinely free when BOTH directions are explicitly zero from the API.
  // Models with missing, unavailable, or invalid pricing are NOT free.
  const isFree = input.status === 'free' && output.status === 'free'
  return {
    input,
    output,
    hasOverrides: Array.isArray(pricing.overrides) && pricing.overrides.length > 0,
    isFree,
  }
}

// ---------------------------------------------------------------------------
// Model identity helpers
// ---------------------------------------------------------------------------

/** Human-readable display name — prefer the Orbio `name` field, fall back to id slug */
export function modelDisplayName(model: OrbioModel | string): string {
  if (typeof model === 'string') {
    const parts = model.split('/')
    return parts[parts.length - 1]
  }
  if (model.name) return model.name
  const parts = model.id.split('/')
  return parts[parts.length - 1]
}

/** Provider slug from model id, e.g. "anthropic/claude-..." → "Anthropic" */
export function modelProvider(idOrModel: OrbioModel | string): string {
  const id = typeof idOrModel === 'string' ? idOrModel : idOrModel.id
  if (typeof idOrModel !== 'string' && idOrModel.owned_by) {
    return idOrModel.owned_by.charAt(0).toUpperCase() + idOrModel.owned_by.slice(1)
  }
  const parts = id.split('/')
  if (parts.length < 2) return 'Unknown'
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
}

/** True when the model ID is a variant (e.g. :batch, :extended) rather than a base model */
export function isVariantModel(id: string): boolean {
  return id.includes(':')
}

/** Variant suffix label, e.g. ":batch" → "batch" */
export function variantLabel(id: string): string | null {
  const idx = id.lastIndexOf(':')
  if (idx === -1) return null
  return id.slice(idx + 1)
}

/** Format context length as human-readable token count */
export function formatContextLength(n: number | undefined): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ctx`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k ctx`
  return `${n} ctx`
}

/** Derive capability badges from architecture + supported_parameters */
export function getCapabilityBadges(model: OrbioModel): string[] {
  const badges: string[] = []
  const params = model.supported_parameters ?? []
  const inputMods = model.architecture?.input_modalities ?? []

  if (inputMods.includes('image') || inputMods.includes('video')) badges.push('vision')
  if (params.includes('tools') || params.includes('tool_choice')) badges.push('tools')
  if (params.includes('reasoning') || params.includes('include_reasoning')) badges.push('reasoning')
  if (params.includes('response_format') || params.includes('structured_outputs')) badges.push('structured output')
  if (params.includes('temperature')) badges.push('streaming')
  if (inputMods.includes('audio')) badges.push('audio')
  if (inputMods.includes('video')) badges.push('video')
  if (inputMods.includes('file')) badges.push('file input')

  return [...new Set(badges)] // deduplicate
}

/** All input modalities as display strings */
export function formatModality(model: OrbioModel): string {
  const modality = model.architecture?.modality
  if (modality) return modality
  return '—'
}

/** Format Unix timestamp from Orbio `created` field */
export function formatModelDate(created: number | undefined): string {
  if (!created) return '—'
  return new Date(created * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

// ---------------------------------------------------------------------------
// Legacy shim — kept so other files that still call the old signature compile
// ---------------------------------------------------------------------------
/** @deprecated Use getModelPricing().output.label instead */
export function formatPricePerMillion(tokenPrice: string | undefined): string {
  const p = parsePriceField(tokenPrice)
  if (p.status === 'paid') return p.label!
  if (p.status === 'free') return 'Free'
  return '—'
}

export function clsx(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ')
}
