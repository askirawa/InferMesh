/**
 * tests/auth.test.ts — EIP-191 wallet authentication tests
 *
 * Tests cover:
 *   - Unit: nonce generation, consumption, expiry, replay, wallet mismatch
 *   - Unit: signature verification (valid, wrong address, wrong message, bad format)
 *   - Unit: buildSignedMessage canonical format
 *   - Integration: GET /nonce endpoint
 *   - Integration: POST /chat — missing headers, bad nonce, replay, sig mismatch, valid auth
 *   - Integration: GET /quota — same auth gates as /chat
 *   - Integration: quota enforcement still works after auth is applied
 *   - Integration: provider errors don't consume quota post-auth
 *   - Integration: auth is bypassed on public routes (/health, /models)
 *
 * No real Orbio API calls are made — the provider is mocked.
 * Test private keys are standard Hardhat/Anvil development keys — never used for real funds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { serve, type Server } from 'bun'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverMessageAddress } from 'viem'
import {
  generateNonce,
  consumeNonce,
  verifyAuthHeaders,
  buildSignedMessage,
  resetNonceStore,
  nonceStore,
  NONCE_TTL_MS,
} from '../server/auth'
import {
  RateLimiter,
  InFlightTracker,
  checkWalletQuota,
  checkGlobalCircuitBreaker,
  validateWalletAddress,
  type QuotaConfig,
} from '../server/quota'

// ── Test accounts (Hardhat/Anvil dev keys — never use for real funds) ─────────

const ACCOUNT_A = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const ACCOUNT_B = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)

// Normalised lowercase addresses
const WALLET_A = ACCOUNT_A.address.toLowerCase()
const WALLET_B = ACCOUNT_B.address.toLowerCase()

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database {
  const dir = join(tmpdir(), `auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, 'test.db'))
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
    CREATE INDEX IF NOT EXISTS idx_usage_wallet_status_created
      ON usage_records (wallet, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_status_created
      ON usage_records (status, created_at);
  `)
  return db
}

function seedRequests(
  db: Database,
  wallet: string,
  count: number,
  opts: { tokens?: number; atMs?: number; status?: string } = {},
) {
  const { tokens = 100, atMs = Date.now(), status = 'success' } = opts
  for (let i = 0; i < count; i++) {
    db.run(
      `INSERT INTO usage_records
         (id, model_id, provider, prompt, status, wallet, input_tokens, output_tokens, created_at)
       VALUES (?, 'test/model', 'orbio', 'test', ?, ?, ?, ?, ?)`,
      [`r_${wallet}_${i}_${Date.now()}_${Math.random()}`, status, wallet,
       Math.floor(tokens / 2), tokens - Math.floor(tokens / 2), atMs + i],
    )
  }
}

const TEST_CFG: QuotaConfig = {
  freeDailyRequests: 5,
  freeDailyTokens: 1000,
  freeRpm: 10,       // generous for auth tests so RPM doesn't interfere
  globalDailyRequests: 500,
  globalDailyTokens: 500_000,
}

// ── Unit: buildSignedMessage ──────────────────────────────────────────────────

describe('buildSignedMessage', () => {
  it('includes the nonce and wallet in the message', () => {
    const msg = buildSignedMessage('abc123', WALLET_A)
    expect(msg).toContain('abc123')
    expect(msg).toContain(WALLET_A)
    expect(msg).toContain('InferMesh authentication nonce:')
  })

  it('is deterministic for the same inputs', () => {
    expect(buildSignedMessage('nonce1', WALLET_A)).toBe(buildSignedMessage('nonce1', WALLET_A))
  })

  it('differs for different nonces', () => {
    expect(buildSignedMessage('nonce1', WALLET_A)).not.toBe(buildSignedMessage('nonce2', WALLET_A))
  })

  it('differs for different wallets', () => {
    expect(buildSignedMessage('nonce1', WALLET_A)).not.toBe(buildSignedMessage('nonce1', WALLET_B))
  })
})

// ── Unit: generateNonce ───────────────────────────────────────────────────────

describe('generateNonce — generation and format', () => {
  beforeAll(() => resetNonceStore())

  it('generates a 64-char hex string', () => {
    const nonce = generateNonce(WALLET_A)
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates unique nonces on each call', () => {
    const n1 = generateNonce(WALLET_A)
    const n2 = generateNonce(WALLET_A)
    expect(n1).not.toBe(n2)
  })

  it('stores the nonce in nonceStore', () => {
    const nonce = generateNonce(WALLET_A)
    expect(nonceStore.has(nonce)).toBe(true)
  })

  it('associates the nonce with the correct wallet', () => {
    const nonce = generateNonce(WALLET_A)
    const entry = nonceStore.get(nonce)
    expect(entry?.wallet).toBe(WALLET_A)
  })

  it('sets expiry in the future', () => {
    const before = Date.now()
    const nonce = generateNonce(WALLET_A)
    const entry = nonceStore.get(nonce)!
    expect(entry.expiresAt).toBeGreaterThan(before)
    expect(entry.expiresAt).toBeLessThanOrEqual(before + NONCE_TTL_MS + 5)
  })
})

// ── Unit: consumeNonce ────────────────────────────────────────────────────────

describe('consumeNonce — validity', () => {
  beforeAll(() => resetNonceStore())

  it('returns the entry for a valid nonce', () => {
    const nonce = generateNonce(WALLET_A)
    const result = consumeNonce(nonce, WALLET_A)
    expect(result).not.toBeNull()
    expect(result?.wallet).toBe(WALLET_A)
  })

  it('deletes the nonce after consumption (single-use)', () => {
    const nonce = generateNonce(WALLET_A)
    consumeNonce(nonce, WALLET_A)
    expect(nonceStore.has(nonce)).toBe(false)
  })

  it('returns null on replay (nonce already consumed)', () => {
    const nonce = generateNonce(WALLET_A)
    consumeNonce(nonce, WALLET_A)           // first use — succeeds
    const result = consumeNonce(nonce, WALLET_A)  // replay — fails
    expect(result).toBeNull()
  })

  it('returns null for an unknown nonce', () => {
    const result = consumeNonce('0'.repeat(64), WALLET_A)
    expect(result).toBeNull()
  })

  it('returns null for a wallet mismatch', () => {
    const nonce = generateNonce(WALLET_A)
    // Nonce was issued for WALLET_A; WALLET_B tries to use it
    const result = consumeNonce(nonce, WALLET_B)
    expect(result).toBeNull()
  })

  it('deletes the nonce even when wallet mismatch (no second chance)', () => {
    const nonce = generateNonce(WALLET_A)
    consumeNonce(nonce, WALLET_B)  // fails — wallet mismatch
    // Even though it failed, the nonce is gone
    expect(nonceStore.has(nonce)).toBe(false)
  })
})

// ── Unit: nonce expiry ────────────────────────────────────────────────────────

describe('consumeNonce — expiry', () => {
  beforeAll(() => resetNonceStore())

  it('returns null for an expired nonce', () => {
    const nonce = generateNonce(WALLET_A)
    // Simulate time past expiry
    const expiredTime = Date.now() + NONCE_TTL_MS + 1000
    const result = consumeNonce(nonce, WALLET_A, expiredTime)
    expect(result).toBeNull()
  })

  it('accepts a nonce 1ms before expiry', () => {
    const now = Date.now()
    const nonce = generateNonce(WALLET_A, now)
    const almostExpired = now + NONCE_TTL_MS - 1
    const result = consumeNonce(nonce, WALLET_A, almostExpired)
    expect(result).not.toBeNull()
  })

  it('deletes an expired nonce (no retry after expiry)', () => {
    const nonce = generateNonce(WALLET_A)
    const expired = Date.now() + NONCE_TTL_MS + 1000
    consumeNonce(nonce, WALLET_A, expired)
    expect(nonceStore.has(nonce)).toBe(false)
  })
})

// ── Unit: verifyAuthHeaders ───────────────────────────────────────────────────

describe('verifyAuthHeaders — valid signature', () => {
  beforeAll(() => resetNonceStore())

  it('returns ok=true and the verified wallet for a valid signature', async () => {
    const nonce = generateNonce(WALLET_A)
    const message = buildSignedMessage(nonce, WALLET_A)
    const sig = await ACCOUNT_A.signMessage({ message })
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': nonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.wallet).toBe(WALLET_A)
    }
  })

  it('accepts mixed-case wallet address and normalises it', async () => {
    const mixedWallet = ACCOUNT_A.address  // checksummed (mixed case)
    const lowerWallet = ACCOUNT_A.address.toLowerCase()
    const nonce = generateNonce(lowerWallet)
    const message = buildSignedMessage(nonce, lowerWallet)
    const sig = await ACCOUNT_A.signMessage({ message })
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': mixedWallet,  // client sends checksummed
        'x-auth-nonce': nonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.wallet).toBe(lowerWallet)
  })
})

describe('verifyAuthHeaders — missing headers', () => {
  it('returns missing_headers when all headers absent', async () => {
    const headers = { get: () => null }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('missing_headers')
  })

  it('returns missing_headers when nonce header is absent', async () => {
    const headers = {
      get: (name: string) => name === 'x-auth-wallet' ? WALLET_A
        : name === 'x-auth-signature' ? '0x' + 'a'.repeat(130) : null,
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('missing_headers')
  })

  it('returns missing_headers when signature header is absent', async () => {
    const nonce = generateNonce(WALLET_A)
    const headers = {
      get: (name: string) => name === 'x-auth-wallet' ? WALLET_A
        : name === 'x-auth-nonce' ? nonce : null,
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('missing_headers')
  })
})

describe('verifyAuthHeaders — format errors', () => {
  it('returns invalid_wallet for a malformed wallet address', async () => {
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': 'notanaddress',
        'x-auth-nonce': 'a'.repeat(64),
        'x-auth-signature': '0x' + 'a'.repeat(130),
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_wallet')
  })

  it('returns invalid_nonce for a nonce that is not 64 hex chars', async () => {
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': 'tooshort',
        'x-auth-signature': '0x' + 'a'.repeat(130),
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_nonce')
  })

  it('returns invalid_signature for a signature that is not 0x+130hex', async () => {
    const nonce = generateNonce(WALLET_A)
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': nonce,
        'x-auth-signature': 'not-a-sig',
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_signature')
  })
})

describe('verifyAuthHeaders — semantic errors', () => {
  beforeAll(() => resetNonceStore())

  it('returns invalid_nonce for an unknown nonce (not in store)', async () => {
    const fakeNonce = 'b'.repeat(64)
    const message = buildSignedMessage(fakeNonce, WALLET_A)
    const sig = await ACCOUNT_A.signMessage({ message })
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': fakeNonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_nonce')
  })

  it('returns invalid_nonce for a replayed nonce', async () => {
    const nonce = generateNonce(WALLET_A)
    const message = buildSignedMessage(nonce, WALLET_A)
    const sig = await ACCOUNT_A.signMessage({ message })
    const makeHeaders = () => ({
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': nonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    })
    const first = await verifyAuthHeaders(makeHeaders())
    expect(first.ok).toBe(true)
    const second = await verifyAuthHeaders(makeHeaders())
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('invalid_nonce')
  })

  it('returns invalid_nonce for an expired nonce', async () => {
    const now = Date.now()
    const nonce = generateNonce(WALLET_A, now)
    const message = buildSignedMessage(nonce, WALLET_A)
    const sig = await ACCOUNT_A.signMessage({ message })
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': nonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    }
    const expiredNow = now + NONCE_TTL_MS + 1000
    const result = await verifyAuthHeaders(headers, expiredNow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_nonce')
  })

  it('returns signature_mismatch when signature is from a different wallet', async () => {
    // WALLET_A claims ownership, but the nonce is signed by ACCOUNT_B
    const nonce = generateNonce(WALLET_A)
    const message = buildSignedMessage(nonce, WALLET_A)
    const sig = await ACCOUNT_B.signMessage({ message })  // wrong signer
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': nonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_mismatch')
  })

  it('returns signature_mismatch when signing the wrong message', async () => {
    const nonce = generateNonce(WALLET_A)
    // Sign a different message (not the canonical one)
    const sig = await ACCOUNT_A.signMessage({ message: `wrong prefix ${nonce}` })
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': nonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_mismatch')
  })

  it('cross-wallet: nonce issued for WALLET_A cannot be used by WALLET_B', async () => {
    // Attacker generates nonce for WALLET_A, tries to use it on behalf of WALLET_B
    const nonce = generateNonce(WALLET_A)  // nonce bound to WALLET_A
    const message = buildSignedMessage(nonce, WALLET_B)  // B signs for itself
    const sig = await ACCOUNT_B.signMessage({ message })
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_B,
        'x-auth-nonce': nonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    // The nonce was issued for WALLET_A but the request claims WALLET_B —
    // consumeNonce checks entry.wallet === wallet and returns null.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_nonce')
  })
})

// ── Integration: inline auth + quota server ───────────────────────────────────

const TEST_PORT = 14202

let testServer: Server
let testDb: Database

beforeAll(() => {
  testDb = makeDb()
  resetNonceStore()

  const rl = new RateLimiter(TEST_CFG.freeRpm)
  const inflight = new InFlightTracker()

  function jsonR(data: unknown, status = 200, extra?: Record<string, string>) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Auth-Wallet,X-Auth-Nonce,X-Auth-Signature',
        ...extra,
      },
    })
  }

  function genId() { return `req_${Date.now()}_${Math.random().toString(36).slice(2)}` }

  testServer = serve({
    port: TEST_PORT,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,X-Auth-Wallet,X-Auth-Nonce,X-Auth-Signature',
        }})
      }

      // Public: health
      if (url.pathname === '/health') {
        return jsonR({ ok: true, hasApiKey: true })
      }

      // Public: nonce issuance
      if (url.pathname === '/nonce' && req.method === 'GET') {
        const raw = url.searchParams.get('wallet')
        const wallet = validateWalletAddress(raw)
        if (!wallet) return jsonR({ error: 'invalid_wallet' }, 400)
        const nonce = generateNonce(wallet)
        const message = buildSignedMessage(nonce, wallet)
        return jsonR({ nonce, wallet, message, expires_in_seconds: 300 })
      }

      // Protected: quota
      if (url.pathname === '/quota' && req.method === 'GET') {
        const auth = await verifyAuthHeaders(req.headers)
        if (!auth.ok) return jsonR({ error: auth.error.code, message: auth.error.message }, 401)
        const { wallet } = auth.value
        const status = checkWalletQuota(testDb, wallet, TEST_CFG)
        const global_ = checkGlobalCircuitBreaker(testDb, TEST_CFG)
        return jsonR({ wallet, ...status, global_circuit_breaker_tripped: global_.tripped, identity_verified: true })
      }

      // Protected: chat
      if (url.pathname === '/chat' && req.method === 'POST') {
        const auth = await verifyAuthHeaders(req.headers)
        if (!auth.ok) return jsonR({ error: auth.error.code, message: auth.error.message }, 401)
        const { wallet } = auth.value

        let body: { model?: string; messages?: unknown[]; providerShouldFail?: boolean }
        try { body = await req.json() as typeof body } catch { return jsonR({ error: 'invalid_body' }, 400) }
        if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
          return jsonR({ error: 'model and messages are required' }, 400)
        }

        const global_ = checkGlobalCircuitBreaker(testDb, TEST_CFG)
        if (global_.tripped) return jsonR({ error: 'service_limit_reached' }, 503)

        if (!rl.allow(wallet)) {
          return jsonR({ error: 'rate_limited', retry_after_seconds: rl.retryAfterSeconds(wallet) }, 429)
        }

        if (!inflight.increment(wallet)) {
          return jsonR({ error: 'too_many_concurrent' }, 429)
        }

        const quota = checkWalletQuota(testDb, wallet, TEST_CFG)
        if (!quota.allowed) {
          inflight.decrement(wallet)
          return jsonR({ error: 'quota_exceeded', reason: quota.reason }, 402)
        }

        const id = genId()
        testDb.run(
          `INSERT INTO usage_records (id, model_id, provider, prompt, status, wallet, created_at)
           VALUES (?, ?, 'orbio', 'test', 'pending', ?, ?)`,
          [id, String(body.model), wallet, Date.now()],
        )

        // Mock provider — optionally simulate failure
        if (body.providerShouldFail) {
          testDb.run(`UPDATE usage_records SET status='error', error='mock error' WHERE id=?`, [id])
          inflight.decrement(wallet)
          return jsonR({ error: 'provider_error', message: 'mock error' }, 502)
        }

        testDb.run(
          `UPDATE usage_records SET status='success', input_tokens=10, output_tokens=20, latency_ms=50 WHERE id=?`,
          [id],
        )
        inflight.decrement(wallet)

        return jsonR({
          id, model: body.model, response: 'mock', usage: { input_tokens: 10, output_tokens: 20 },
          latency_ms: 50, balance_after: null, finish_reason: 'stop',
          quota: { used_requests: quota.used_requests + 1, limit_requests: TEST_CFG.freeDailyRequests,
            used_tokens: quota.used_tokens + 30, limit_tokens: TEST_CFG.freeDailyTokens,
            resets_at: quota.resets_at },
        })
      }

      return jsonR({ error: 'not_found' }, 404)
    },
  })
})

afterAll(() => {
  testServer.stop()
  testDb.close()
  resetNonceStore()
})

const BASE = `http://localhost:${TEST_PORT}`

/** Fetch a nonce and sign it with the given account. Returns auth headers. */
async function getSignedHeaders(
  account: typeof ACCOUNT_A,
  wallet: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/nonce?wallet=${wallet}`)
  const data = await res.json() as { nonce: string; message: string }
  const sig = await account.signMessage({ message: data.message })
  return {
    'Content-Type': 'application/json',
    'X-Auth-Wallet': wallet,
    'X-Auth-Nonce': data.nonce,
    'X-Auth-Signature': sig,
  }
}

async function chatWith(account: typeof ACCOUNT_A, wallet: string, opts: {
  model?: string
  providerShouldFail?: boolean
  headers?: Record<string, string>
} = {}) {
  const headers = opts.headers ?? await getSignedHeaders(account, wallet)
  return fetch(`${BASE}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: opts.model ?? 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
      providerShouldFail: opts.providerShouldFail ?? false,
    }),
  })
}

// ── Integration: GET /nonce ───────────────────────────────────────────────────

describe('GET /nonce', () => {
  it('returns a 64-char hex nonce for a valid wallet', async () => {
    const res = await fetch(`${BASE}/nonce?wallet=${WALLET_A}`)
    expect(res.status).toBe(200)
    const data = await res.json() as { nonce: string; wallet: string; expires_in_seconds: number }
    expect(data.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(data.wallet).toBe(WALLET_A)
    expect(data.expires_in_seconds).toBe(300)
  })

  it('returns 400 for an invalid wallet', async () => {
    const res = await fetch(`${BASE}/nonce?wallet=notanaddress`)
    expect(res.status).toBe(400)
  })

  it('returns a different nonce on each call', async () => {
    const r1 = await fetch(`${BASE}/nonce?wallet=${WALLET_A}`)
    const r2 = await fetch(`${BASE}/nonce?wallet=${WALLET_A}`)
    const d1 = await r1.json() as { nonce: string }
    const d2 = await r2.json() as { nonce: string }
    expect(d1.nonce).not.toBe(d2.nonce)
  })

  it('includes the canonical message to sign', async () => {
    const res = await fetch(`${BASE}/nonce?wallet=${WALLET_A}`)
    const data = await res.json() as { nonce: string; message: string }
    // Verify the returned message matches what buildSignedMessage would produce
    expect(data.message).toContain(data.nonce)
    expect(data.message).toContain(WALLET_A)
    expect(data.message).toContain('InferMesh authentication nonce:')
  })
})

// ── Integration: POST /chat — auth gates ──────────────────────────────────────

describe('POST /chat — returns 401 without auth headers', () => {
  it('returns 401 when all auth headers are missing', async () => {
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('missing_headers')
  })

  it('returns 401 when nonce header is missing', async () => {
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Wallet': WALLET_A,
        'X-Auth-Signature': '0x' + 'a'.repeat(130),
      },
      body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a replayed nonce (second use)', async () => {
    const headers = await getSignedHeaders(ACCOUNT_A, WALLET_A)
    // First use — succeeds
    await fetch(`${BASE}/chat`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // Second use with same headers — nonce already consumed
    const res2 = await fetch(`${BASE}/chat`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res2.status).toBe(401)
    const data = await res2.json() as { error: string }
    expect(data.error).toBe('invalid_nonce')
  })

  it('returns 401 for an expired nonce', async () => {
    // Generate a nonce directly with a past timestamp so it's already expired
    const now = Date.now()
    const wallet = WALLET_A
    const nonce = generateNonce(wallet, now - NONCE_TTL_MS - 1000)
    const message = buildSignedMessage(nonce, wallet)
    const sig = await ACCOUNT_A.signMessage({ message })
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Wallet': wallet,
        'X-Auth-Nonce': nonce,
        'X-Auth-Signature': sig,
      },
      body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('invalid_nonce')
  })

  it('returns 401 when signature is from a different wallet', async () => {
    // Get a nonce for WALLET_A, but sign it as ACCOUNT_B
    const nonceRes = await fetch(`${BASE}/nonce?wallet=${WALLET_A}`)
    const { nonce, message } = await nonceRes.json() as { nonce: string; message: string }
    const sig = await ACCOUNT_B.signMessage({ message })  // wrong signer
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Wallet': WALLET_A,
        'X-Auth-Nonce': nonce,
        'X-Auth-Signature': sig,
      },
      body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('signature_mismatch')
  })
})

describe('POST /chat — succeeds with valid auth', () => {
  it('returns 200 with a valid nonce+signature', async () => {
    const res = await chatWith(ACCOUNT_A, WALLET_A)
    expect(res.status).toBe(200)
    const data = await res.json() as { response: string; quota: unknown }
    expect(data.response).toBe('mock')
    expect(data.quota).toBeDefined()
  })

  it('body wallet field is not used as identity (only X-Auth-Wallet is)', async () => {
    // Send a body with WALLET_B but authenticate as WALLET_A
    // The server should attribute the request to WALLET_A (from headers)
    const headers = await getSignedHeaders(ACCOUNT_A, WALLET_A)
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'test/model',
        messages: [{ role: 'user', content: 'hi' }],
        wallet: WALLET_B,  // ignored
      }),
    })
    // Request should succeed under WALLET_A's quota, not WALLET_B's
    expect(res.status).toBe(200)
  })
})

// ── Integration: GET /quota — auth gates ─────────────────────────────────────

describe('GET /quota — auth required', () => {
  it('returns 401 without auth headers', async () => {
    const res = await fetch(`${BASE}/quota`)
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('missing_headers')
  })

  it('returns 200 with valid auth and identity_verified: true', async () => {
    const headers = await getSignedHeaders(ACCOUNT_A, WALLET_A)
    const res = await fetch(`${BASE}/quota`, { headers })
    expect(res.status).toBe(200)
    const data = await res.json() as { wallet: string; identity_verified: boolean; allowed: boolean }
    expect(data.wallet).toBe(WALLET_A)
    expect(data.identity_verified).toBe(true)
    expect(typeof data.allowed).toBe('boolean')
  })

  it('returns 401 for replayed nonce on /quota', async () => {
    const headers = await getSignedHeaders(ACCOUNT_A, WALLET_A)
    await fetch(`${BASE}/quota`, { headers })  // first use
    const res2 = await fetch(`${BASE}/quota`, { headers })  // replay
    expect(res2.status).toBe(401)
  })
})

// ── Integration: public routes bypass auth ────────────────────────────────────

describe('Public routes — no auth required', () => {
  it('/health returns 200 without auth', async () => {
    const res = await fetch(`${BASE}/health`)
    expect(res.status).toBe(200)
  })
})

// ── Integration: quota still enforced after auth ──────────────────────────────

describe('Quota enforcement with auth', () => {
  const QUOTA_WALLET = '0x' + 'c1'.repeat(20)  // unique wallet for this test group

  it('returns 402 when quota is exhausted, even with valid auth', async () => {
    // Pre-seed to exhaust quota
    seedRequests(testDb, QUOTA_WALLET, TEST_CFG.freeDailyRequests)

    // Now try to send — should get 402 (quota), not 401 (auth)
    // The QUOTA_WALLET and acct wallet are different — use QUOTA_WALLET with ACCOUNT_A auth
    // by seeding the DB for WALLET_A instead, then using ACCOUNT_A
    const quotaWalletA = WALLET_A
    // Reset WALLET_A's records (if any) and re-seed to exactly the limit
    testDb.run(`DELETE FROM usage_records WHERE wallet=? AND status='success'`, [quotaWalletA])
    seedRequests(testDb, quotaWalletA, TEST_CFG.freeDailyRequests)

    const res = await chatWith(ACCOUNT_A, quotaWalletA)
    expect(res.status).toBe(402)
    const data = await res.json() as { error: string; reason: string }
    expect(data.error).toBe('quota_exceeded')

    // Cleanup for other tests
    testDb.run(`DELETE FROM usage_records WHERE wallet=?`, [quotaWalletA])
  })

  it('provider failure does not consume quota', async () => {
    // Use ACCOUNT_B for WALLET_B as a clean wallet — no complex key derivation needed.
    // First, ensure WALLET_B has no usage today.
    testDb.run(`DELETE FROM usage_records WHERE wallet=?`, [WALLET_B])

    // Send a request that causes a provider error
    const res = await chatWith(ACCOUNT_B, WALLET_B, { providerShouldFail: true })
    expect(res.status).toBe(502)

    // Check quota — should still be 0 requests used
    const headers = await getSignedHeaders(ACCOUNT_B, WALLET_B)
    const quotaRes = await fetch(`${BASE}/quota`, { headers })
    const quotaData = await quotaRes.json() as { used_requests: number }
    expect(quotaData.used_requests).toBe(0)
  })

  it('successful request increments quota correctly', async () => {
    // Use WALLET_B which was just cleaned above
    testDb.run(`DELETE FROM usage_records WHERE wallet=?`, [WALLET_B])

    const res = await chatWith(ACCOUNT_B, WALLET_B)
    expect(res.status).toBe(200)

    const headers = await getSignedHeaders(ACCOUNT_B, WALLET_B)
    const quotaRes = await fetch(`${BASE}/quota`, { headers })
    const quotaData = await quotaRes.json() as { used_requests: number }
    expect(quotaData.used_requests).toBe(1)
  })
})

// ── Unit: nonce NOT consumed on bad signature (DoS prevention) ───────────────

describe('verifyAuthHeaders — nonce survives a bad signature', () => {
  beforeAll(() => resetNonceStore())

  it('nonce is NOT consumed when sig is malformed (invalid format rejects before consume)', async () => {
    // Format check rejects before we even look at the store, so nonce is never touched.
    const nonce = generateNonce(WALLET_A)
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': nonce,
        'x-auth-signature': 'not-a-sig',  // fails format check
      }[name.toLowerCase()] ?? null),
    }
    await verifyAuthHeaders(headers)
    // Nonce is still in the store — victim can still use it
    expect(nonceStore.has(nonce)).toBe(true)
  })

  it('nonce is NOT consumed when signature is from the wrong wallet', async () => {
    // WALLET_A's nonce, signed by ACCOUNT_B — sig_mismatch but nonce should survive
    const nonce = generateNonce(WALLET_A)
    const message = buildSignedMessage(nonce, WALLET_A)
    const sig = await ACCOUNT_B.signMessage({ message })  // wrong signer
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': nonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_mismatch')
    // Nonce must still be in the store — the attacker did not burn it
    expect(nonceStore.has(nonce)).toBe(true)
  })

  it('nonce is NOT consumed when signing the wrong message', async () => {
    const nonce = generateNonce(WALLET_A)
    // ACCOUNT_A signs a different message — the recovered address will differ
    const sig = await ACCOUNT_A.signMessage({ message: `tampered ${nonce}` })
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': nonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_mismatch')
    // Nonce must still be in the store
    expect(nonceStore.has(nonce)).toBe(true)
  })

  it('nonce IS consumed after a valid signature', async () => {
    const nonce = generateNonce(WALLET_A)
    const message = buildSignedMessage(nonce, WALLET_A)
    const sig = await ACCOUNT_A.signMessage({ message })
    const headers = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A,
        'x-auth-nonce': nonce,
        'x-auth-signature': sig,
      }[name.toLowerCase()] ?? null),
    }
    const result = await verifyAuthHeaders(headers)
    expect(result.ok).toBe(true)
    // Nonce must be gone — single use
    expect(nonceStore.has(nonce)).toBe(false)
  })

  it('replay is still rejected even though bad-sig no longer burns the nonce', async () => {
    // First attempt: bad sig — nonce survives
    const nonce = generateNonce(WALLET_A)
    const message = buildSignedMessage(nonce, WALLET_A)
    const badSig = await ACCOUNT_B.signMessage({ message })
    const badHeaders = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A, 'x-auth-nonce': nonce, 'x-auth-signature': badSig,
      }[name.toLowerCase()] ?? null),
    }
    const first = await verifyAuthHeaders(badHeaders)
    expect(first.ok).toBe(false)
    expect(nonceStore.has(nonce)).toBe(true)  // still alive

    // Second attempt: correct sig — succeeds and consumes the nonce
    const goodSig = await ACCOUNT_A.signMessage({ message })
    const goodHeaders = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A, 'x-auth-nonce': nonce, 'x-auth-signature': goodSig,
      }[name.toLowerCase()] ?? null),
    }
    const second = await verifyAuthHeaders(goodHeaders)
    expect(second.ok).toBe(true)
    expect(nonceStore.has(nonce)).toBe(false) // consumed

    // Third attempt: nonce replay — rejected
    const thirdHeaders = {
      get: (name: string) => ({
        'x-auth-wallet': WALLET_A, 'x-auth-nonce': nonce, 'x-auth-signature': goodSig,
      }[name.toLowerCase()] ?? null),
    }
    const third = await verifyAuthHeaders(thirdHeaders)
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.error.code).toBe('invalid_nonce')
  })
})

// ── Integration: DoS nonce-burn via HTTP ─────────────────────────────────────

describe('Integration: attacker cannot burn victim nonce via HTTP', () => {
  it('attacker bad-sig leaves nonce usable; victim succeeds on the same nonce', async () => {
    // Attacker sees WALLET_A's nonce (nonce fetch is public) and sends a bad sig.
    const nonceRes = await fetch(`${BASE}/nonce?wallet=${WALLET_A}`)
    const { nonce, message } = await nonceRes.json() as { nonce: string; message: string }

    // Attacker signs with ACCOUNT_B (wrong key) — should get 401 but NOT burn the nonce
    const attackerSig = await ACCOUNT_B.signMessage({ message })
    const attackRes = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Wallet': WALLET_A,
        'X-Auth-Nonce': nonce,
        'X-Auth-Signature': attackerSig,
      },
      body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(attackRes.status).toBe(401)
    const attackData = await attackRes.json() as { error: string }
    expect(attackData.error).toBe('signature_mismatch')

    // Victim now uses the same nonce with the correct signature — should succeed
    const victimSig = await ACCOUNT_A.signMessage({ message })
    const victimRes = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Wallet': WALLET_A,
        'X-Auth-Nonce': nonce,
        'X-Auth-Signature': victimSig,
      },
      body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // Should succeed (200) or fail for a quota/rate reason, NOT 401
    expect(victimRes.status).not.toBe(401)
    // Clean up
    testDb.run(`DELETE FROM usage_records WHERE wallet=?`, [WALLET_A])
  })
})

// ── Integration: quota attribution to authenticated wallet ────────────────────

describe('Integration: quota is attributed to the authenticated wallet, not body wallet', () => {
  it('body wallet field does not affect which wallet is charged', async () => {
    // Clean slate for both wallets
    testDb.run(`DELETE FROM usage_records WHERE wallet=?`, [WALLET_A])
    testDb.run(`DELETE FROM usage_records WHERE wallet=?`, [WALLET_B])

    // Authenticate as WALLET_A but send WALLET_B in the body
    const headers = await getSignedHeaders(ACCOUNT_A, WALLET_A)
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'test/model',
        messages: [{ role: 'user', content: 'hi' }],
        wallet: WALLET_B,  // should be ignored
      }),
    })
    expect(res.status).toBe(200)

    // WALLET_A should have 1 request recorded
    const quotaAHeaders = await getSignedHeaders(ACCOUNT_A, WALLET_A)
    const quotaARes = await fetch(`${BASE}/quota`, { headers: quotaAHeaders })
    const quotaA = await quotaARes.json() as { used_requests: number }
    expect(quotaA.used_requests).toBe(1)

    // WALLET_B should have 0 requests (body wallet was ignored)
    const quotaBHeaders = await getSignedHeaders(ACCOUNT_B, WALLET_B)
    const quotaBRes = await fetch(`${BASE}/quota`, { headers: quotaBHeaders })
    const quotaB = await quotaBRes.json() as { used_requests: number }
    expect(quotaB.used_requests).toBe(0)

    // Clean up
    testDb.run(`DELETE FROM usage_records WHERE wallet=?`, [WALLET_A])
  })
})

// ── Integration: CORS preflight includes auth headers ────────────────────────

describe('CORS', () => {
  it('OPTIONS preflight includes X-Auth-* in Access-Control-Allow-Headers', async () => {
    const res = await fetch(`${BASE}/chat`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    const allow = res.headers.get('Access-Control-Allow-Headers') ?? ''
    expect(allow).toContain('X-Auth-Wallet')
    expect(allow).toContain('X-Auth-Nonce')
    expect(allow).toContain('X-Auth-Signature')
  })
})

// ── Unit: viem round-trip (sanity check) ─────────────────────────────────────

describe('viem EIP-191 round-trip (sanity)', () => {
  it('recoverMessageAddress returns the signing account address', async () => {
    const message = 'test message for sanity'
    const sig = await ACCOUNT_A.signMessage({ message })
    const recovered = await recoverMessageAddress({ message, signature: sig })
    expect(recovered.toLowerCase()).toBe(WALLET_A)
  })

  it('buildSignedMessage + sign + recover returns the correct wallet', async () => {
    const nonce = 'a'.repeat(64)
    const message = buildSignedMessage(nonce, WALLET_A)
    const sig = await ACCOUNT_A.signMessage({ message })
    const recovered = await recoverMessageAddress({ message, signature: sig })
    expect(recovered.toLowerCase()).toBe(WALLET_A)
  })
})
