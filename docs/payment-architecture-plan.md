# InferMesh — Payment Architecture Plan

_Audit date: Oct 13 2026. Based on direct inspection of all source files._

---

## 1. What Already Exists and Can Be Reused

### Backend (`server/index.ts`)
| Item | Status | Reuse |
|---|---|---|
| Bun HTTP server, single-file | Exists | Extend in-place |
| SQLite via `bun:sqlite`, `.data/infermesh.db` | Exists | Add tables with `ALTER TABLE` / new `CREATE TABLE` |
| `usage_records` table | Exists | Add columns: `credit_source`, `cost_usd` already present (always NULL currently) |
| `/chat` POST — records pending→success/error lifecycle | Exists | Add free-allowance gate before Orbio call |
| `/health` — boolean `hasApiKey` | Exists | Extend with `freeRequestsRemaining` per wallet |
| `/usage` + `/usage/stats` — parameterised queries | Exists | Extend stats to include credit balance |
| Input sanitisation (length caps, array limits) | Exists | Keep |
| `ORBIO_API_KEY` server-side only | Exists | Keep unchanged |

### Frontend
| Item | Status | Reuse |
|---|---|---|
| Wallet connection (wagmi + ConnectKit, Arc Mainnet chain ID 5042) | Exists | Reuse entirely |
| Real USDC balance read via `balanceOf` on `0x3600…` | Exists | Reuse for purchase flow |
| Chain-switch guard (`isOnArc`) | Exists | Reuse to gate purchase button |
| "Payment Architecture — Pending deployment" note in WalletPage | Exists | Replace with real UI in Phase 3 |
| Dashboard, Explore Models, Playground, Usage pages | Exists | Preserve all |

### Contracts
No application contracts are deployed. Only Foundry scaffold scripts (`contracts/script/`) exist. The `contracts/out/` directory contains only standard Foundry library ABIs. No escrow or payment contract exists yet.

### Onchain Facts
Arc Mainnet facts are correct in `onchain-facts.ts`:
- Chain ID: `5042`
- USDC ERC-20: `0x3600000000000000000000000000000000000000`, 6 decimals
- Native gas token: also USDC, 18 decimals (important: these are the SAME pool, different decimal representations)
- Explorer: `https://explorer.arc.io`

---

## 2. What Is Missing

### 2a. Backend gaps
| Missing | Risk if absent |
|---|---|
| Per-wallet free-allowance table and enforcement | Any wallet can run unlimited free inference |
| Token-count limit per free request | A single free request can exhaust provider budget |
| Global provider-spend cap / circuit-breaker | Orbio balance can be drained if rate limiting fails |
| Rate limiting (requests per minute per wallet) | Burst abuse, Orbio rate limits hit server-side |
| Credit balance table (wallet → USDC credits) | No paid tier possible |
| Payment receipt table (tx hash → amount → credited) | Double-spend on payment tx hash |
| On-chain payment verification (RPC call to check tx) | Frontend can lie about payment success |
| `cost_usd` population from Orbio pricing data | Currently always NULL; credits cannot be deducted |
| Idempotency key on `/chat` | Concurrent duplicate requests both consume credits |

### 2b. Smart contract gaps
| Missing | Notes |
|---|---|
| Payment contract (deposit / credit top-up) | Required for on-chain verification |
| No escrow logic yet | Simple `transfer` to a fixed address is enough for Phase 1 verification |

### 2c. Frontend gaps
| Missing | Notes |
|---|---|
| Free-allowance status display (requests remaining) | Users don't know when free tier ends |
| Purchase credits UI | Not built |
| Payment confirmation flow (send USDC → notify backend) | Not built |
| Credit balance display | Not built |

---

## 3. Phased Implementation Plan

### Phase 1 — Free-tier enforcement (no contract needed)
_Goal: stop unlimited free inference. Safe to ship immediately._

**Backend changes (`server/index.ts` + new schema):**

```sql
-- New table
CREATE TABLE IF NOT EXISTS wallets (
  address        TEXT PRIMARY KEY,          -- lowercase hex
  free_requests_used   INTEGER NOT NULL DEFAULT 0,
  free_tokens_used     INTEGER NOT NULL DEFAULT 0,
  credits_usd          REAL    NOT NULL DEFAULT 0.0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
```

Gate in `/chat` handler (before Orbio call):
1. Reject if no wallet address provided (anonymous users cannot use inference).
2. Look up wallet row. Create it on first request.
3. Check `free_requests_used < FREE_REQUEST_LIMIT` AND `free_tokens_used < FREE_TOKEN_LIMIT`.
4. If over limit AND `credits_usd < estimated_cost` → return `402 payment_required`.
5. After successful response: increment `free_requests_used`, add actual tokens to `free_tokens_used`.
6. Add global in-memory counter for requests-per-minute per wallet (reset every 60s). Return `429` when exceeded.

Config (env vars, with safe defaults):
```
FREE_REQUEST_LIMIT=10          # requests per wallet lifetime (configurable)
FREE_TOKEN_LIMIT=50000         # total tokens across free requests
RATE_LIMIT_RPM=5               # max requests per minute per wallet
GLOBAL_SPEND_CAP_USD=10.0      # total USD Orbio spend before server stops accepting requests
```

**Files to change:** `server/index.ts` (schema, `/chat` gate, new `/quota` route).

---

### Phase 2 — Cost accounting
_Goal: populate `cost_usd` accurately so credit deductions are correct._

The Orbio model catalogue already provides `pricing.prompt` and `pricing.completion` per-token costs (validated in `src/lib/utils.ts`). The backend needs to:

1. Fetch and cache the model catalogue on startup (refresh every 10 min).
2. After a successful `/chat` response, look up `pricing.prompt` and `pricing.completion` for the returned `model` ID.
3. Compute: `cost = (input_tokens * prompt_price) + (output_tokens * completion_price)`.
4. Store in `usage_records.cost_usd`.
5. Keep `x-orbio-balance` from response headers as a secondary check.

**Files to change:** `server/index.ts` (model cache, cost calculation).

---

### Phase 3 — USDC payment and credit top-up
_Goal: let users buy credits. Requires a smart contract and explicit approval._

#### 3a. Smart contract
The safest minimal contract for on-chain verification:

```solidity
// InferMeshCredits.sol  (to be written and audited before deploy)
// Users call: topUp(uint256 usdcAmount)
//   - transfers USDC from user to contract
//   - emits TopUp(address indexed user, uint256 amount, uint256 indexed nonce)
// Owner calls: withdraw(uint256 amount) to recover provider costs
// No escrow per-request — credits are server-side after on-chain verification
```

Key design decisions requiring your confirmation:
- **Simple transfer, not per-request escrow.** The contract only accepts deposits and emits events. Credit balance is tracked server-side. This avoids per-request gas costs and complexity.
- **Owner withdrawal.** You control the contract and can recover USDC to pay Orbio. Requires a trusted owner address.
- **No refunds in v1.** Credits are non-refundable on purchase. Refunds require additional contract logic.

#### 3b. Backend payment verification (`server/index.ts`)

New table:
```sql
CREATE TABLE IF NOT EXISTS payment_receipts (
  tx_hash        TEXT PRIMARY KEY,          -- prevents double-processing
  wallet         TEXT NOT NULL,
  amount_usdc    REAL NOT NULL,
  block_number   INTEGER,
  verified_at    INTEGER,
  status         TEXT NOT NULL DEFAULT 'pending'  -- pending | verified | failed
);
```

New route: `POST /payments/verify`
```
Body: { txHash: string, wallet: string }
```

Steps (all server-side):
1. Reject if `tx_hash` already in `payment_receipts` (idempotency).
2. Insert row with `status='pending'`.
3. Call Arc Mainnet RPC: `eth_getTransactionReceipt(txHash)`.
4. Verify: receipt exists, `status === 1` (success), `to` address matches contract, `from` matches claimed wallet (case-insensitive).
5. Decode the `TopUp` event log: confirm `user == wallet`, extract `amount`.
6. Verify `blockNumber` is at least 1 block behind current head (finality guard).
7. Update `payment_receipts` → `status='verified'`.
8. Credit `wallets.credits_usd += amount_usdc`.
9. Return new credit balance.

**Never trust the frontend's reported amount.** Always read it from the decoded event log.

#### 3c. Frontend changes
- `WalletPage.tsx`: replace "Pending deployment" note with a purchase form.
  - Input: USDC amount.
  - Button: calls USDC `approve` then contract `topUp`.
  - On transaction confirmed: calls `/payments/verify` with tx hash and wallet.
  - Shows new credit balance.
- `Playground.tsx`: show credit balance and remaining free requests from `/quota?wallet=`.

---

## 4. Files That Would Change Per Phase

| File | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| `server/index.ts` | Schema, `/chat` gate, `/quota`, rate limiter | Model cache, cost calc | `/payments/verify`, receipt table |
| `src/lib/api.ts` | Add `quota()` client call | — | Add `verifyPayment()` |
| `src/components/Playground.tsx` | Show quota banner | Show per-request cost | Show credit balance |
| `src/components/WalletPage.tsx` | Show quota status | — | Full purchase UI |
| `src/components/Dashboard.tsx` | Show free requests used | Show cost totals | Show credits |
| `contracts/InferMeshCredits.sol` | — | — | New contract (needs audit) |
| `tests/` | Quota enforcement tests | Cost calc tests | Payment verification tests |

---

## 5. Security Risks and Decisions Requiring Your Confirmation

### Decisions you must make before Phase 3

| Decision | Options | Recommendation |
|---|---|---|
| **Contract ownership** | Your wallet, a multisig, a hardware wallet | Use a hardware wallet or multisig for mainnet |
| **Refund policy** | No refunds (simpler), time-locked refunds (complex) | No refunds in v1; add later |
| **Minimum top-up** | Any amount vs minimum (e.g. $1) | Minimum prevents dust attacks |
| **Credit expiry** | Never expire vs expire after N days | Never expire in v1 |
| **Global spend cap** | Hard stop vs alert only | Hard stop recommended |

### Security risks identified in current code

| Risk | Severity | Fix |
|---|---|---|
| No wallet authentication — any wallet string accepted as identity | High | Phase 1: require wallet in all inference requests; Phase 3: sign a nonce |
| `cost_usd` always NULL — cannot deduct credits accurately | High | Phase 2 |
| No idempotency on `/chat` — concurrent requests both go through | Medium | Phase 1: per-wallet in-flight lock (SQLite transaction or in-memory set) |
| CORS set to `*` — any origin can call backend | Medium | Restrict to the Vite preview hostname in production |
| No finality check on payment tx | High | Phase 3: require N confirmations before crediting |
| Wallet address from request body trusted without signature | High | Acceptable for free tier; Phase 3 must add EIP-191 nonce signing |

### Risks that are already handled well
- `ORBIO_API_KEY` is server-side only, never in `src/`.
- SQL queries are parameterised (fixed in previous turn).
- Model ID passes through without transformation.
- `/health` returns only a boolean, never the key.
- `.env` is in `.gitignore`.

---

## 6. Concurrent Request Handling

SQLite is single-writer. The following pattern is safe for Phase 1:

```typescript
// Atomic check-and-increment in a single transaction
const allowed = db.transaction(() => {
  const row = db.query(`SELECT * FROM wallets WHERE address=?`).get(wallet)
  if (!row) { /* insert new row */ }
  if (row.free_requests_used >= FREE_REQUEST_LIMIT) return false
  db.run(`UPDATE wallets SET free_requests_used = free_requests_used + 1 WHERE address=?`, [wallet])
  return true
})()
```

SQLite's serialised write model means this transaction is atomic — no two concurrent requests can both pass the limit check.

For Phase 3 payment verification, the `payment_receipts` PRIMARY KEY on `tx_hash` makes double-processing impossible: the second insert will throw a UNIQUE constraint violation, which the handler catches and returns a 409.

---

## 7. Provider Balance and Global Spend Cap

Orbio returns `x-orbio-balance` in response headers. The backend should:
1. Store the most recent balance in memory (refreshed per response).
2. Refuse new inference requests when `balance < MINIMUM_ORBIO_BALANCE` (e.g. $0.50).
3. Alert via the `/health` endpoint so the dashboard can show a warning.

This prevents the server from continuing to serve paid inference when the Orbio account is dry.
