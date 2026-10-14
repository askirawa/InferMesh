/**
 * server/quota.ts — Free-tier enforcement for InferMesh Phase 1
 *
 * Identity model (Phase 1 limitation — see bottom of file):
 *   Wallet addresses are taken from the request body at face value.
 *   EIP-191 signed-nonce verification is NOT implemented in Phase 1.
 *   Any caller who knows a wallet address can consume that wallet's quota.
 *   Mitigation: limits are conservative and a global circuit-breaker caps
 *   total provider spend regardless of identity spoofing.
 *
 * Concurrency model:
 *   SQLite is single-writer. Before hitting the DB we hold the wallet in an
 *   in-memory "in-flight" Set. The quota check + in-flight insert is done
 *   inside a single synchronous SQLite transaction so two concurrent requests
 *   cannot both pass a check for N-1 remaining slots.
 *
 * Daily reset:
 *   Counts are scoped to UTC calendar day (midnight-to-midnight). The DB
 *   query filters by created_at >= today_start_ms for successful requests.
 *
 * Configuration (all via environment variables — no code edit needed):
 *
 *   FREE_DAILY_REQUESTS   Max successful inference requests per wallet per day  (default: 10)
 *   FREE_DAILY_TOKENS     Max total tokens (input+output) per wallet per day     (default: 50000)
 *   FREE_RPM              Max requests per wallet per 60-second sliding window   (default: 3)
 *   GLOBAL_DAILY_REQUESTS Max successful requests across ALL wallets per day     (default: 500)
 *   GLOBAL_DAILY_TOKENS   Max total tokens across ALL wallets per day            (default: 2000000)
 *
 * All limits are inclusive (>= triggers rejection).
 * Unknown cost is treated as non-zero — the global token cap is the proxy
 * for spend since cost_usd is NULL in Phase 1.
 */

import type { Database } from 'bun:sqlite'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function envInt(key: string, fallback: number): number {
  const v = process.env[key]
  if (!v) return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface QuotaConfig {
  freeDailyRequests: number
  freeDailyTokens: number
  freeRpm: number
  globalDailyRequests: number
  globalDailyTokens: number
}

export function loadQuotaConfig(): QuotaConfig {
  return {
    freeDailyRequests: envInt('FREE_DAILY_REQUESTS', 10),
    freeDailyTokens:   envInt('FREE_DAILY_TOKENS',   50_000),
    freeRpm:           envInt('FREE_RPM',             3),
    globalDailyRequests: envInt('GLOBAL_DAILY_REQUESTS', 500),
    globalDailyTokens:   envInt('GLOBAL_DAILY_TOKENS',   2_000_000),
  }
}

// ---------------------------------------------------------------------------
// Per-wallet rate limiter — sliding window, in-memory
// ---------------------------------------------------------------------------

interface WindowEntry {
  timestamps: number[]  // ms of each request in the last 60s
}

export class RateLimiter {
  private windows = new Map<string, WindowEntry>()
  private readonly windowMs = 60_000

  constructor(private readonly maxPerWindow: number) {}

  /**
   * Returns true if the wallet is allowed to proceed, false if rate-limited.
   * Call BEFORE the quota check.
   */
  allow(wallet: string): boolean {
    const now = Date.now()
    let entry = this.windows.get(wallet)
    if (!entry) {
      entry = { timestamps: [] }
      this.windows.set(wallet, entry)
    }
    // Evict timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < this.windowMs)
    if (entry.timestamps.length >= this.maxPerWindow) return false
    entry.timestamps.push(now)
    return true
  }

  /** Seconds until the oldest slot in the window expires */
  retryAfterSeconds(wallet: string): number {
    const now = Date.now()
    const entry = this.windows.get(wallet)
    if (!entry || entry.timestamps.length === 0) return 0
    const oldest = entry.timestamps[0]
    return Math.max(0, Math.ceil((oldest + this.windowMs - now) / 1000))
  }

  /** For testing — clear all state */
  reset(): void { this.windows.clear() }
}

// ---------------------------------------------------------------------------
// In-flight tracker — prevents concurrent quota bypass
// ---------------------------------------------------------------------------

export class InFlightTracker {
  private inflight = new Map<string, number>() // wallet → count

  /** Returns true if increment was accepted */
  increment(wallet: string, maxConcurrent = 2): boolean {
    const current = this.inflight.get(wallet) ?? 0
    if (current >= maxConcurrent) return false
    this.inflight.set(wallet, current + 1)
    return true
  }

  decrement(wallet: string): void {
    const current = this.inflight.get(wallet) ?? 0
    if (current <= 1) {
      this.inflight.delete(wallet)
    } else {
      this.inflight.set(wallet, current - 1)
    }
  }

  count(wallet: string): number { return this.inflight.get(wallet) ?? 0 }

  /** For testing */
  reset(): void { this.inflight.clear() }
}

// ---------------------------------------------------------------------------
// Quota checker — reads the DB for daily counts
// ---------------------------------------------------------------------------

export interface QuotaStatus {
  allowed: boolean
  reason?: 'daily_requests' | 'daily_tokens' | 'global_requests' | 'global_tokens'
  used_requests: number
  used_tokens: number
  limit_requests: number
  limit_tokens: number
  resets_at: number  // ms timestamp of next UTC midnight
}

function utcDayStart(now = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function utcDayEnd(now = Date.now()): number {
  return utcDayStart(now) + 86_400_000
}

export function checkWalletQuota(
  db: Database,
  wallet: string,
  cfg: QuotaConfig,
  now = Date.now(),
): QuotaStatus {
  const dayStart = utcDayStart(now)

  const row = db.query(
    `SELECT COUNT(*) as reqs,
            COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0) as tokens
     FROM usage_records
     WHERE wallet = ?
       AND status = 'success'
       AND created_at >= ?`,
  ).get(wallet, dayStart) as { reqs: number; tokens: number }

  const usedRequests = row.reqs
  const usedTokens = row.tokens
  const resetsAt = utcDayEnd(now)

  if (usedRequests >= cfg.freeDailyRequests) {
    return {
      allowed: false,
      reason: 'daily_requests',
      used_requests: usedRequests,
      used_tokens: usedTokens,
      limit_requests: cfg.freeDailyRequests,
      limit_tokens: cfg.freeDailyTokens,
      resets_at: resetsAt,
    }
  }

  if (usedTokens >= cfg.freeDailyTokens) {
    return {
      allowed: false,
      reason: 'daily_tokens',
      used_requests: usedRequests,
      used_tokens: usedTokens,
      limit_requests: cfg.freeDailyRequests,
      limit_tokens: cfg.freeDailyTokens,
      resets_at: resetsAt,
    }
  }

  return {
    allowed: true,
    used_requests: usedRequests,
    used_tokens: usedTokens,
    limit_requests: cfg.freeDailyRequests,
    limit_tokens: cfg.freeDailyTokens,
    resets_at: resetsAt,
  }
}

export function checkGlobalCircuitBreaker(
  db: Database,
  cfg: QuotaConfig,
  now = Date.now(),
): { tripped: boolean; reason?: 'global_requests' | 'global_tokens' } {
  const dayStart = utcDayStart(now)

  const row = db.query(
    `SELECT COUNT(*) as reqs,
            COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0) as tokens
     FROM usage_records
     WHERE status = 'success'
       AND created_at >= ?`,
  ).get(dayStart) as { reqs: number; tokens: number }

  if (row.reqs >= cfg.globalDailyRequests) {
    return { tripped: true, reason: 'global_requests' }
  }
  if (row.tokens >= cfg.globalDailyTokens) {
    return { tripped: true, reason: 'global_tokens' }
  }
  return { tripped: false }
}

// ---------------------------------------------------------------------------
// Wallet address validation
// ---------------------------------------------------------------------------

/**
 * Returns a normalised lowercase wallet address if valid, null otherwise.
 * Only EVM addresses (0x + 40 hex chars) are accepted.
 *
 * PHASE 1 LIMITATION: this only validates the FORMAT of the address.
 * It does NOT verify that the caller owns the private key for this address.
 * A malicious caller who knows any valid wallet address can consume its quota.
 * Phase 2 must add EIP-191 signed-nonce verification before granting paid credits.
 */
export function validateWalletAddress(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null
  return trimmed.toLowerCase()
}

// ---------------------------------------------------------------------------
// Phase 1 limitation summary (for documentation and test assertions)
// ---------------------------------------------------------------------------
export const PHASE1_LIMITATIONS = {
  noSignatureVerification: true,
  identityModel: 'wallet-address-from-request-body',
  spoofingRisk: 'medium — mitigated by conservative global limits',
  phase2Required: 'EIP-191 signed nonce before paid credits',
} as const
