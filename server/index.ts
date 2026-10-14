/**
 * InferMesh backend server
 * Proxies Orbio inference API, stores usage records in SQLite.
 *
 * Phase 1: free-tier quota enforcement — see server/quota.ts for limits.
 * Hardening: EIP-191 wallet ownership verification — see server/auth.ts for flow.
 *
 * Authentication flow for /chat and /quota:
 *   1. GET /nonce?wallet=0x...  →  { nonce: "<64-char hex>" }
 *   2. Client signs: buildSignedMessage(nonce, wallet) with personal_sign
 *   3. POST /chat  with headers: X-Auth-Wallet, X-Auth-Nonce, X-Auth-Signature
 *      GET  /quota with headers: same
 *
 * HTTP status codes:
 *   401  — missing or invalid auth headers, expired/replayed nonce, sig mismatch
 *   400  — malformed request body / missing required fields
 *   402  — per-wallet quota exhausted
 *   429  — rate limited or too many concurrent requests
 *   503  — global circuit-breaker tripped or missing ORBIO_API_KEY
 */
import { serve } from 'bun'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { mkdirSync } from 'fs'
import {
  loadQuotaConfig,
  RateLimiter,
  InFlightTracker,
  checkWalletQuota,
  checkGlobalCircuitBreaker,
  validateWalletAddress,
} from './quota'
import {
  generateNonce,
  verifyAuthHeaders,
  buildSignedMessage,
} from './auth'

const PORT = 3001
const DB_DIR = join(import.meta.dir, '../.data')
mkdirSync(DB_DIR, { recursive: true })

const db = new Database(join(DB_DIR, 'infermesh.db'))

// ── Schema ─────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_records (
    id            TEXT PRIMARY KEY,
    model_id      TEXT NOT NULL,
    provider      TEXT NOT NULL DEFAULT 'orbio',
    prompt        TEXT NOT NULL,
    response      TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    cost_usd      REAL,
    latency_ms    INTEGER,
    status        TEXT NOT NULL DEFAULT 'pending',
    error         TEXT,
    wallet        TEXT,
    created_at    INTEGER NOT NULL
  );

  -- Phase 1: index for fast daily quota queries
  CREATE INDEX IF NOT EXISTS idx_usage_wallet_status_created
    ON usage_records (wallet, status, created_at);

  CREATE INDEX IF NOT EXISTS idx_usage_status_created
    ON usage_records (status, created_at);
`)

// ── Config ──────────────────────────────────────────────────────────────────
const ORBIO_BASE = 'https://api.orbio.so/api/v1'
const ORBIO_API_KEY = process.env.ORBIO_API_KEY ?? ''

const cfg = loadQuotaConfig()
const rateLimiter = new RateLimiter(cfg.freeRpm)
const inFlight = new InFlightTracker()

// ── CORS allowed headers ─────────────────────────────────────────────────────
// Must include auth headers so browsers send them on cross-origin requests.
const CORS_ALLOW_HEADERS = 'Content-Type,X-Auth-Wallet,X-Auth-Nonce,X-Auth-Signature'

// ── Helpers ─────────────────────────────────────────────────────────────────
function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  })
}

function corsOk() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    },
  })
}

function generateId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

// ── Server ───────────────────────────────────────────────────────────────────
serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'OPTIONS') return corsOk()

    // ── Health ──────────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return json({
        ok: true,
        hasApiKey: ORBIO_API_KEY.length > 0,
        quota: {
          freeDailyRequests: cfg.freeDailyRequests,
          freeDailyTokens: cfg.freeDailyTokens,
          freeRpm: cfg.freeRpm,
          globalDailyRequests: cfg.globalDailyRequests,
          globalDailyTokens: cfg.globalDailyTokens,
        },
        auth: {
          required: true,
          scheme: 'EIP-191 nonce/signature',
          nonce_ttl_seconds: 300,
          endpoints_protected: ['/chat', '/quota'],
          nonce_endpoint: 'GET /nonce?wallet=<address>',
        },
      })
    }

    // ── Nonce issuance ───────────────────────────────────────────────────────
    // GET /nonce?wallet=0x...
    // Returns a single-use, 5-minute-expiry nonce for the given wallet.
    // No authentication required — the nonce itself is not sensitive.
    if (url.pathname === '/nonce' && req.method === 'GET') {
      const rawWallet = url.searchParams.get('wallet')
      const wallet = validateWalletAddress(rawWallet)
      if (!wallet) {
        return json({
          error: 'invalid_wallet',
          message: 'wallet must be a valid EVM address (0x + 40 hex chars)',
        }, 400)
      }
      const nonce = generateNonce(wallet)
      const message = buildSignedMessage(nonce, wallet)
      return json({
        nonce,
        wallet,
        message,  // The exact string to sign — included so client can verify it constructs it correctly
        expires_in_seconds: 300,
      })
    }

    // ── Quota status for a wallet ─────────────────────────────────────────────
    // GET /quota — requires valid auth headers
    if (url.pathname === '/quota' && req.method === 'GET') {
      const authResult = await verifyAuthHeaders(req.headers)
      if (!authResult.ok) {
        return json({
          error: authResult.error.code,
          message: authResult.error.message,
        }, 401)
      }
      const { wallet } = authResult.value

      const status = checkWalletQuota(db, wallet, cfg)
      const global_ = checkGlobalCircuitBreaker(db, cfg)
      return json({
        wallet,
        ...status,
        global_circuit_breaker_tripped: global_.tripped,
        global_reason: global_.reason ?? null,
        identity_verified: true,  // signature was verified — address is authenticated
      })
    }

    // ── Models catalogue ─────────────────────────────────────────────────────
    // No auth required — public catalogue
    if (url.pathname === '/models' && req.method === 'GET') {
      try {
        const res = await fetch(`${ORBIO_BASE}/models?output_modalities=text`, {
          headers: ORBIO_API_KEY ? { Authorization: `Bearer ${ORBIO_API_KEY}` } : {},
          signal: AbortSignal.timeout(10_000),
        })
        const data = await res.json() as unknown
        return json(data, res.status)
      } catch (err) {
        return json({ error: 'Failed to fetch models', detail: String(err) }, 502)
      }
    }

    // ── Chat completions ─────────────────────────────────────────────────────
    // POST /chat — requires valid auth headers
    if (url.pathname === '/chat' && req.method === 'POST') {
      if (!ORBIO_API_KEY) {
        return json({
          error: 'missing_api_key',
          message: 'ORBIO_API_KEY is not configured on the server. Add it to your .env file.',
        }, 503)
      }

      // ── Auth verification ────────────────────────────────────────────────
      const authResult = await verifyAuthHeaders(req.headers)
      if (!authResult.ok) {
        return json({
          error: authResult.error.code,
          message: authResult.error.message,
        }, 401)
      }
      const { wallet } = authResult.value
      // wallet is now cryptographically verified — it cannot be spoofed

      // ── Parse body ──────────────────────────────────────────────────────
      let body: {
        model: string
        messages: Array<{ role: string; content: string }>
        max_tokens?: number
        temperature?: number
        // wallet field in the body is IGNORED — wallet comes from verified headers only
      }
      try {
        body = await req.json() as typeof body
      } catch {
        return json({ error: 'invalid_body' }, 400)
      }

      if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
        return json({ error: 'model and messages are required' }, 400)
      }

      // ── Sanitize ────────────────────────────────────────────────────────
      const model = String(body.model).slice(0, 256)
      const messages = body.messages.slice(0, 64).map((m) => ({
        role: String(m.role).slice(0, 32),
        content: String(m.content).slice(0, 32_768),
      }))

      // ── Global circuit-breaker (fail closed) ────────────────────────────
      const global_ = checkGlobalCircuitBreaker(db, cfg)
      if (global_.tripped) {
        return json({
          error: 'service_limit_reached',
          message: 'InferMesh has reached its global daily inference limit. ' +
            'Service resets at UTC midnight. No provider requests are being made.',
          reason: global_.reason,
        }, 503)
      }

      // ── Per-wallet rate limit (requests per minute) ──────────────────────
      if (!rateLimiter.allow(wallet)) {
        const retryAfter = rateLimiter.retryAfterSeconds(wallet)
        return json({
          error: 'rate_limited',
          message: `You are sending requests too quickly. ` +
            `Maximum ${cfg.freeRpm} requests per minute. ` +
            `Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
          retry_after_seconds: retryAfter,
        }, 429, { 'Retry-After': String(retryAfter) })
      }

      // ── Concurrent-request guard (in-memory) ────────────────────────────
      // Prevents two simultaneous requests from both reading quota=N-1
      // and both proceeding. Max 2 concurrent requests per wallet.
      if (!inFlight.increment(wallet)) {
        return json({
          error: 'too_many_concurrent',
          message: 'You already have the maximum number of requests in flight. ' +
            'Wait for a response before sending another.',
        }, 429)
      }

      // ── Daily quota check (DB read — inside in-flight guard) ─────────────
      const quotaStatus = checkWalletQuota(db, wallet, cfg)
      if (!quotaStatus.allowed) {
        inFlight.decrement(wallet)
        const resetsIn = Math.ceil((quotaStatus.resets_at - Date.now()) / 3_600_000)
        return json({
          error: 'quota_exceeded',
          message: quotaStatus.reason === 'daily_tokens'
            ? `Your free daily token limit (${cfg.freeDailyTokens.toLocaleString()} tokens) is exhausted. ` +
              `Quota resets in ~${resetsIn}h at UTC midnight.`
            : `Your free daily request limit (${cfg.freeDailyRequests} requests) is exhausted. ` +
              `Quota resets in ~${resetsIn}h at UTC midnight.`,
          reason: quotaStatus.reason,
          used_requests: quotaStatus.used_requests,
          limit_requests: quotaStatus.limit_requests,
          used_tokens: quotaStatus.used_tokens,
          limit_tokens: quotaStatus.limit_tokens,
          resets_at: quotaStatus.resets_at,
          // Phase 2 will add: payment_url, credits_available
        }, 402)
      }

      // ── Record the pending request ───────────────────────────────────────
      const id = generateId()
      const created_at = Date.now()

      db.run(
        `INSERT INTO usage_records (id, model_id, provider, prompt, status, wallet, created_at)
         VALUES (?, ?, 'orbio', ?, 'pending', ?, ?)`,
        [id, model, messages[messages.length - 1].content.slice(0, 2048), wallet, created_at],
      )

      // ── Provider request ─────────────────────────────────────────────────
      const start = performance.now()
      try {
        const orbioRes = await fetch(`${ORBIO_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ORBIO_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: body.max_tokens ?? 1024,
            temperature: body.temperature ?? 0.7,
          }),
          signal: AbortSignal.timeout(90_000),
        })

        const latency_ms = Math.round(performance.now() - start)
        const balanceAfter = orbioRes.headers.get('x-orbio-balance')

        if (!orbioRes.ok) {
          const errBody = await orbioRes.text()
          db.run(
            `UPDATE usage_records SET status='error', error=?, latency_ms=? WHERE id=?`,
            [errBody.slice(0, 1024), latency_ms, id],
          )
          // Provider error does NOT count against quota (no tokens consumed)
          inFlight.decrement(wallet)
          return json({
            error: 'provider_error',
            status: orbioRes.status,
            message: errBody.slice(0, 512),
          }, orbioRes.status >= 400 && orbioRes.status < 600 ? orbioRes.status : 502)
        }

        const completion = await orbioRes.json() as {
          id?: string
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
          model?: string
        }

        const responseText = completion.choices?.[0]?.message?.content ?? ''
        const inputTokens = completion.usage?.prompt_tokens ?? null
        const outputTokens = completion.usage?.completion_tokens ?? null

        // cost_usd stays NULL in Phase 1 — Orbio bills server-side.
        // Phase 2 will populate this from model pricing data.
        const costUsd: number | null = null

        db.run(
          `UPDATE usage_records
           SET status='success', response=?, input_tokens=?, output_tokens=?, cost_usd=?, latency_ms=?
           WHERE id=?`,
          [responseText.slice(0, 8192), inputTokens, outputTokens, costUsd, latency_ms, id],
        )

        inFlight.decrement(wallet)

        return json({
          id,
          model: completion.model ?? model,
          response: responseText,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
          latency_ms,
          balance_after: balanceAfter,
          finish_reason: completion.choices?.[0]?.finish_reason ?? null,
          quota: {
            used_requests: quotaStatus.used_requests + 1,
            limit_requests: cfg.freeDailyRequests,
            used_tokens: quotaStatus.used_tokens + (inputTokens ?? 0) + (outputTokens ?? 0),
            limit_tokens: cfg.freeDailyTokens,
            resets_at: quotaStatus.resets_at,
          },
        })
      } catch (err) {
        const latency_ms = Math.round(performance.now() - start)
        const errMsg = String(err)
        db.run(
          `UPDATE usage_records SET status='error', error=?, latency_ms=? WHERE id=?`,
          [errMsg.slice(0, 1024), latency_ms, id],
        )
        // Timeout / network error does NOT consume quota
        inFlight.decrement(wallet)
        return json({ error: 'request_failed', message: errMsg.slice(0, 256) }, 502)
      }
    }

    // ── Usage records ────────────────────────────────────────────────────────
    if (url.pathname === '/usage' && req.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200)
      const offset = parseInt(url.searchParams.get('offset') ?? '0')
      const wallet = url.searchParams.get('wallet')

      const records = wallet
        ? db.query(
            `SELECT id, model_id, provider, input_tokens, output_tokens, cost_usd, latency_ms, status, wallet, created_at
             FROM usage_records WHERE wallet=? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          ).all(wallet, limit, offset)
        : db.query(
            `SELECT id, model_id, provider, input_tokens, output_tokens, cost_usd, latency_ms, status, wallet, created_at
             FROM usage_records ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          ).all(limit, offset)

      const total = wallet
        ? (db.query(`SELECT COUNT(*) as n FROM usage_records WHERE wallet=?`).get(wallet) as { n: number }).n
        : (db.query(`SELECT COUNT(*) as n FROM usage_records`).get() as { n: number }).n

      return json({ records, total, limit, offset })
    }

    // ── Single usage record ──────────────────────────────────────────────────
    if (url.pathname.startsWith('/usage/') && req.method === 'GET') {
      const id = url.pathname.slice('/usage/'.length)
      if (!id || id.includes('/')) return json({ error: 'not_found' }, 404)
      const record = db.query(`SELECT * FROM usage_records WHERE id=?`).get(id)
      if (!record) return json({ error: 'not_found' }, 404)
      return json(record)
    }

    // ── Usage stats summary ──────────────────────────────────────────────────
    if (url.pathname === '/usage/stats' && req.method === 'GET') {
      const wallet = url.searchParams.get('wallet')

      const stats = wallet
        ? db.query(
            `SELECT COUNT(*) as total_requests,
                    SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as total_tokens,
                    SUM(cost_usd) as total_cost_usd
             FROM usage_records WHERE wallet=?`,
          ).get(wallet) as { total_requests: number; total_tokens: number; total_cost_usd: number | null }
        : db.query(
            `SELECT COUNT(*) as total_requests,
                    SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as total_tokens,
                    SUM(cost_usd) as total_cost_usd
             FROM usage_records`,
          ).get() as { total_requests: number; total_tokens: number; total_cost_usd: number | null }

      const recent = wallet
        ? db.query(
            `SELECT id, model_id, status, latency_ms, created_at
             FROM usage_records WHERE wallet=? ORDER BY created_at DESC LIMIT 5`,
          ).all(wallet)
        : db.query(
            `SELECT id, model_id, status, latency_ms, created_at
             FROM usage_records ORDER BY created_at DESC LIMIT 5`,
          ).all()

      return json({ ...stats, recent })
    }

    return json({ error: 'not_found' }, 404)
  },
})

console.log(`InferMesh backend running on http://localhost:${PORT}`)
console.log(`Quota: ${cfg.freeDailyRequests} req/day, ${cfg.freeDailyTokens} tok/day, ${cfg.freeRpm} rpm per wallet`)
console.log(`Global circuit-breaker: ${cfg.globalDailyRequests} req/day, ${cfg.globalDailyTokens} tok/day`)
console.log(`Auth: EIP-191 nonce/signature required on /chat and /quota`)
