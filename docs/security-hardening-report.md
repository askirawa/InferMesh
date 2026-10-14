# InferMesh Security Hardening Report
## Phase 1 → Pre-Phase 2 Hardening Pass

**Date:** 2026-10-13
**Scope:** Free-tier enforcement hardening, EIP-191 wallet ownership verification, in-memory safeguard documentation.

---

## 1. Changes Made

### 1.1 `server/auth.ts` (new)

All authentication logic in one file. Exported API used by `server/index.ts`.

| Symbol | Purpose |
|---|---|
| `generateNonce(wallet)` | Produces a 32-byte cryptographically random nonce (64 hex chars), stores it with the wallet address and a 5-minute expiry. |
| `consumeNonce(nonce, wallet)` | Atomically looks up and deletes the nonce. Returns null if unknown, expired, or issued for a different wallet. Deletes on every outcome — no second chance even on failure. |
| `verifyAuthHeaders(headers)` | Full verification pipeline: format-check address/nonce/sig, consume nonce, recover signer with viem `recoverMessageAddress`, compare to claimed address. Returns a discriminated union `AuthResult`. |
| `buildSignedMessage(nonce, wallet)` | Canonical message string. Nonce + wallet both embedded — a signature for wallet A cannot be replayed against wallet B. |
| `nonceStore` / `resetNonceStore` | Exported for white-box testing only. |
| `NONCE_TTL_MS` | 5 minutes, exported so tests can exercise expiry. |

### 1.2 `server/index.ts` (updated)

- Added `GET /nonce?wallet=<address>` endpoint (public — no auth required). Returns nonce, wallet, canonical message, and expiry seconds.
- `POST /chat` and `GET /quota` now call `verifyAuthHeaders()` before any quota or DB logic. A 401 is returned (with specific error code) before touching the quota state.
- `Access-Control-Allow-Headers` now includes `X-Auth-Wallet,X-Auth-Nonce,X-Auth-Signature` on both preflight and success responses — previously only `Content-Type` was listed, which would have caused browsers to silently drop the auth headers.
- Body `wallet` field on `/chat` is ignored as an identity source. The verified address from headers is the only source of truth.
- `/health` now advertises the auth scheme so clients can inspect it programmatically.

### 1.3 `src/lib/auth.ts` (new)

`useAuth()` React hook. Manages the full client-side flow:

1. Eagerly fetches a nonce from `GET /nonce` on wallet connect (avoids round-trip delay on first request).
2. Signs lazily — only when `getAuthHeaders()` is called (user's first actual request), not at connect time.
3. Caches the signed headers until the nonce is consumed (typically one request). On 401, `invalidate()` fetches a fresh nonce.
4. Deduplicates concurrent sign prompts — two simultaneous calls to `getAuthHeaders()` share the same sign promise.
5. Auth state machine: `disconnected → fetching_nonce → ready → signing → signed → (error)`.

### 1.4 `src/lib/api.ts` (updated)

- `api.chat(req, authHeaders)` — auth headers are now a required second argument.
- `api.quota(authHeaders)` — now takes auth headers instead of a plain wallet string.
- `api.nonce(wallet)` — new method for fetching a nonce.
- `get()` and `post()` both accept an optional `extraHeaders` argument.
- Thrown errors now carry `.status` and `.code` fields so the caller can distinguish 401 from 402/429.

### 1.5 `src/components/Playground.tsx` (updated)

- Imports and calls `useAuth()`.
- `handleSend()` calls `getAuthHeaders()` before each request. On 401, calls `invalidate()` and retries once with a fresh nonce (handles the common "nonce just expired" case transparently).
- Auth status chip in the header shows: `Fetching nonce…`, `Awaiting signature…`, `Verified` (with shield icon), or `Auth error`.
- `sendErrorCode` now includes `'auth_error'` with a distinct orange banner.
- Quota is fetched after auth transitions to `signed` (previously fetched on raw wallet connect, before auth was available).
- "Authenticating…" shown in the typing indicator while `isAuthenticating` is true.

### 1.6 `tests/auth.test.ts` (new)

53 new tests across 14 describe blocks. See section 4 for full list.

---

## 2. Authentication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Client (browser)                  Server                         │
│                                                                  │
│  1. Wallet connects                                              │
│  2. GET /nonce?wallet=0xABCD ──────────────────→                 │
│                               generateNonce(0xabcd)              │
│                               store: {nonce → {wallet, exp}}     │
│     ← { nonce, message, expires_in_seconds: 300 } ────────────  │
│                                                                  │
│  3. (user sends first request)                                   │
│     wallet.signMessage(message) → 0xSIG                         │
│                                                                  │
│  4. POST /chat                                                   │
│     X-Auth-Wallet:    0xabcd                                     │
│     X-Auth-Nonce:     <nonce>                                    │
│     X-Auth-Signature: 0xSIG ───────────────────→                │
│                               verifyAuthHeaders():               │
│                                 1. format-check wallet/nonce/sig │
│                                 2. consumeNonce(nonce, 0xabcd)   │
│                                    — deletes nonce from store    │
│                                    — returns null if expired     │
│                                    — returns null if replayed    │
│                                 3. recoverMessageAddress(msg,sig)│
│                                    → 0xRECOVERED                 │
│                                 4. 0xRECOVERED == 0xabcd? ✓     │
│                               — wallet identity is now proven    │
│                               quota check (DB) — uses 0xabcd     │
│     ← 200 { response, quota } ─────────────────────────────────  │
│                                                                  │
│  5. Next request: nonce already consumed → 401 → client calls   │
│     invalidate() → fetches new nonce → signs → retries          │
└─────────────────────────────────────────────────────────────────┘
```

**HTTP status codes:**

| Status | Meaning |
|---|---|
| 401 `missing_headers` | No auth headers present |
| 401 `invalid_wallet` | X-Auth-Wallet not a valid EVM address |
| 401 `invalid_nonce` | Nonce unknown, expired, or already consumed |
| 401 `signature_mismatch` | Recovered signer ≠ claimed wallet |
| 401 `invalid_signature` | Signature does not parse (wrong format) |
| 400 | Malformed body or missing required fields |
| 402 | Quota exhausted |
| 429 | Rate limited or too many concurrent requests |
| 503 | Global circuit-breaker tripped or missing API key |

---

## 3. Known Limitations

### 3.1 RateLimiter and InFlightTracker — in-memory only

Both are `Map<string, ...>` instances inside the Bun process. This has two consequences:

**Process restart:** On restart (crash, deploy, OS signal), all rate-limiter windows and in-flight counts are lost. A wallet that had 2/3 rpm slots used will start fresh. This is a UX tolerance, not a security issue — the worst case is a burst of extra requests immediately after restart, bounded by the per-wallet daily quota in the DB (which persists).

**Multi-instance / horizontal scaling:** If two instances run simultaneously (e.g. behind a load balancer), each has its own `RateLimiter` and `InFlightTracker`. A wallet can send `freeRpm` requests to instance A and another `freeRpm` to instance B in the same minute. Similarly, the in-flight guard does not prevent concurrent bypass across instances.

**Mitigation for the current deployment (single process):** The per-wallet daily quota is enforced in SQLite and is not affected by restarts or in-memory loss. The global circuit-breaker is also DB-backed. The rate limiter and in-flight guard are a quality-of-service defence, not the primary quota enforcement.

**What to do before scaling:** Replace `RateLimiter` and `InFlightTracker` with Redis-backed equivalents (e.g. a sliding window using `ZADD`/`ZRANGEBYSCORE`, and a Redis counter for in-flight). No change to `server/quota.ts` is required — it is already DB-backed.

### 3.2 UTC midnight quota boundary

`checkWalletQuota` filters `created_at >= utcDayStart(now)`. Two edge cases:

**Requests spanning midnight:** A request inserted at 23:59:59 with a 90-second provider timeout completes at 00:01:29 the next day. The record was inserted in "yesterday" so it counts against yesterday's quota. The quota check at insert time was correct. No double-counting occurs.

**Overlapping requests near midnight with the in-flight guard:** If two requests start at 23:59:58 and 23:59:59, both pass the quota check (yesterday's count). Both insert pending records in yesterday. Both complete in today. Today's quota query sees 0 records (the records have yesterday's `created_at`) and allows N fresh requests. The effective "overshoot" is bounded by `maxConcurrent` (default 2) — at most 2 extra requests can slip through the midnight boundary per wallet.

### 3.3 Provider cost is never treated as zero

`cost_usd` is NULL for all Phase 1 records (Orbio bills server-side). The global circuit-breaker uses **request count** as the primary safeguard, not `SUM(cost_usd)`. A NULL cost record still increments `COUNT(*)`. The token cap (`SUM(input_tokens + output_tokens)`) is the secondary proxy for spend. `COALESCE(input_tokens, 0)` prevents NULL tokens from reducing the sum — they contribute zero rather than being excluded.

**Verified in test:** `parsePriceField` and `checkGlobalCircuitBreaker` both have specific tests for NULL/zero-cost records. The "fails closed on unknown cost" invariant holds for Phase 1.

### 3.4 Nonce store in-memory loss on restart

Nonces are kept in a `Map` inside the process. On restart, all pending nonces are lost. Any client whose nonce was fetched before the restart will receive a 401 on its next request. The client (`useAuth`) handles this via `invalidate()` + retry — this is transparent to the user (they see a 1-request retry delay, not an error).

**Not a security concern:** An attacker cannot benefit from nonce loss. The store is purely additive from the attacker's perspective — losing it only removes opportunity, not grants it.

### 3.5 Manual verification remaining

- **Live inference test:** Cannot be automated without consuming real Orbio API credits. Verify manually by sending a request through the Playground with a valid `ORBIO_API_KEY` and checking that the response returns `identity_verified: true` from `GET /quota`.
- **Mobile layout:** The "Awaiting signature…" banner and auth-status chip have not been verified on a physical narrow viewport.
- **Wallet sign prompt UX:** The sign prompt fires on the first request after wallet connect. On wallets with slow confirmation (hardware wallets), the 5-minute nonce TTL is generous, but the user should be informed they have 5 minutes. The current Playground banner says "approve in your wallet" without mentioning the timeout — acceptable for Phase 1.

---

## 4. Tests Added (53 new, 163 total)

### Unit: `buildSignedMessage` (4 tests)
- Nonce and wallet embedded; deterministic; different per nonce; different per wallet.

### Unit: `generateNonce` (5 tests)
- 64-char hex format; uniqueness; nonceStore insertion; wallet association; future expiry.

### Unit: `consumeNonce — validity` (6 tests)
- Returns entry for valid nonce; deletes after consumption; null on replay; null for unknown; null for wallet mismatch; deletes even on wallet mismatch.

### Unit: `consumeNonce — expiry` (3 tests)
- Null for expired; accepts 1ms before expiry; deletes expired nonce.

### Unit: `verifyAuthHeaders — valid signature` (2 tests)
- Full round-trip; mixed-case address normalisation.

### Unit: `verifyAuthHeaders — missing headers` (3 tests)
- All absent; nonce absent; signature absent.

### Unit: `verifyAuthHeaders — format errors` (3 tests)
- Malformed wallet; short nonce; bad signature format.

### Unit: `verifyAuthHeaders — semantic errors` (5 tests)
- Unknown nonce; replay; expired; wrong signer; cross-wallet nonce misuse.

### Integration: `GET /nonce` (4 tests)
- 64-char hex; 400 for invalid wallet; uniqueness; canonical message included.

### Integration: `POST /chat — auth gates` (5 tests)
- 401 no headers; 401 missing nonce; 401 replay; 401 expired; 401 wrong signer.

### Integration: `POST /chat — valid auth` (2 tests)
- 200 round-trip; body wallet field ignored.

### Integration: `GET /quota — auth gates` (3 tests)
- 401 no headers; 200 with valid auth + `identity_verified: true`; 401 replay.

### Integration: Public routes (1 test)
- `/health` returns 200 without auth.

### Integration: Quota enforcement with auth (3 tests)
- 402 on exhausted quota; provider failure doesn't consume quota; success increments correctly.

### Integration: CORS (1 test)
- OPTIONS preflight includes `X-Auth-*` in `Access-Control-Allow-Headers`.

### Unit: viem round-trip sanity (2 tests)
- `recoverMessageAddress` returns signing address; `buildSignedMessage + sign + recover` is consistent.

---

## 5. Files Changed

| File | Status | Summary |
|---|---|---|
| `server/auth.ts` | New | Nonce store, EIP-191 signature verification |
| `server/index.ts` | Updated | `/nonce` endpoint, auth on `/chat`/`/quota`, CORS header fix |
| `src/lib/auth.ts` | New | `useAuth` hook — nonce fetch, sign, cache, invalidate |
| `src/lib/api.ts` | Updated | `api.nonce()`, auth-header params on `chat`/`quota`, typed errors |
| `src/components/Playground.tsx` | Updated | Wired `useAuth`, 401 retry, auth status UI, `auth_error` banner |
| `tests/auth.test.ts` | New | 53 tests covering all auth paths |
| `AGENTS.md` | Updated | Routes table, Phase 1 limits, auth scheme documented |

**No new runtime dependencies added.** `viem/accounts` (`privateKeyToAccount`) is used in tests only — it is in the existing pre-installed `viem` package. `recoverMessageAddress` from `viem` is used in `server/auth.ts` — same package.

---

## 6. Review Pass — 2026-10-13 (post-implementation code review)

### Issues found and fixed

**Issue 1 — Nonce consumed before signature verification (DoS risk, fixed)**

Original `verifyAuthHeaders()` called `consumeNonce()` before `recoverMessageAddress()`. An attacker who could observe or predict a victim's nonce (the `/nonce` endpoint is public) could POST to `/chat` with the victim's nonce and a random signature: the nonce would be consumed and the request rejected with 401, but the victim's nonce was now gone. The victim's next request would also fail (different 401 from a missing nonce), and the client would prompt the user to sign again.

**Fix:** `verifyAuthHeaders()` now verifies the signature before consuming the nonce. Wallet-mismatch and expiry are still checked before the sig (cheap checks first, no EC math wasted). A bad signature leaves the nonce intact so the legitimate owner can still use it. Replay is still blocked: the nonce is consumed immediately after a successful verification. The fix was validated with 5 new unit tests and 1 new integration test.

**Issue 2 — Artificial 400ms sleep before 401 retry (quality, fixed)**

`Playground.handleSend()` called `invalidate()` then `await new Promise(r => setTimeout(r, 400))` before retrying. `invalidate()` starts a nonce fetch immediately and stores the promise in `nonceFetchRef`. `getAuthHeaders()` in the retry path awaits `nonceFetchRef.current` when state is `fetching_nonce`, so the sleep was redundant — the retry would have awaited the fetch correctly without it. The sleep was removed.

### Issues reviewed and confirmed not bugs

**Cached signature returned on subsequent calls:** `getAuthHeaders()` returns the cached `(nonce, sig)` when state is `'signed'`. The server consumes the nonce on first use and returns 401 on replay. Playground calls `invalidate()` on 401, which fetches a fresh nonce and triggers a new sign prompt. This is by design — every new request needs a fresh nonce+sig. The only UX cost is one sign prompt per chat turn, which is acceptable for Phase 1.

**Wallet disconnect state cleanup:** `useEffect([address])` in `useAuth` fires immediately when `address` becomes `undefined` (ConnectKit disconnect), sets state to `'disconnected'`, and nulls `nonceFetchRef` and `signPromiseRef`. Previous wallet's headers cannot be reused.

**Wallet switch state cleanup:** Switching wallets changes `address`, which fires `useEffect([address])` with the new value. The old state is overwritten (`setAuthState({ status: 'fetching_nonce' })`), old refs are nulled by the cancellation guard (`if (nonceFetchRef.current === p)`), and a new nonce is fetched for the new address. Old headers are never returned.

**UTC midnight boundary overshoot:** At most 2 requests (the `maxConcurrent` cap) can span the midnight boundary per wallet per day. This is an acceptable precision tolerance documented in 3.2.

**RateLimiter / InFlightTracker restart behavior:** Documented in 3.1. In-memory loss on restart does not affect the daily quota (DB-backed) or the global circuit-breaker (DB-backed). The worst case is a short burst after restart — acceptable for a single-process deployment.

### Tests added in this review pass (7 new, 170 total)

**Unit — `verifyAuthHeaders — nonce survives a bad signature` (5 tests):**
- Malformed sig format leaves nonce intact.
- Wrong-wallet sig (`signature_mismatch`) leaves nonce intact.
- Wrong-message sig leaves nonce intact.
- Valid sig consumes the nonce.
- Bad-sig then good-sig succeeds; subsequent replay is rejected.

**Integration — attacker cannot burn victim nonce via HTTP (1 test):**
- Attacker sends wrong sig on victim's nonce; gets 401 `signature_mismatch`; victim's correct sig on the same nonce then succeeds.

**Integration — quota attributed to authenticated wallet, not body wallet (1 test):**
- Auth headers identify WALLET_A; body sends WALLET_B; WALLET_A gets 1 request charged, WALLET_B gets 0.

---

## 7. Phase 2 Prerequisites (not started)

Before beginning Phase 2 (cost accounting / populate `cost_usd`):

1. **ORBIO_API_KEY rotation:** The key `sk-orbio-oNKg64ui...` appeared in chat history. Rotate it at orbio.so before any production use.
2. **Redis for rate limiter:** Required before horizontal scaling. Not needed for single-process MVP.
3. **Nonce persistence (optional):** If process restarts are frequent, persist nonces to a fast DB (Redis TTL is ideal). Single-process deployments tolerate in-memory nonce loss.
4. **Cost model:** Phase 2 must determine per-model pricing from the Orbio catalogue and write a non-NULL `cost_usd` per record. The global circuit-breaker's token cap remains the primary safeguard until cost is reliable.
