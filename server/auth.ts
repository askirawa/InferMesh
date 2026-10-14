/**
 * server/auth.ts — EIP-191 wallet ownership verification for InferMesh
 *
 * Flow:
 *   1. Client calls GET /nonce?wallet=0x... → receives a short-lived one-time nonce string.
 *   2. Client signs the canonical message (see NONCE_MESSAGE_PREFIX) with their wallet's
 *      private key using eth_sign / personal_sign (EIP-191 "\x19Ethereum Signed Message:\n").
 *   3. Client sends subsequent requests with two HTTP headers:
 *        X-Auth-Wallet:    0x<address>
 *        X-Auth-Signature: 0x<65-byte hex sig>
 *      The body no longer needs a `wallet` field.
 *   4. Server calls verifyAuthHeaders(), which:
 *        a. validates address format
 *        b. looks up and atomically consumes the nonce (single-use, expires after NONCE_TTL_MS)
 *        c. recovers the signer from the signature and compares it to the claimed address
 *   5. Returns the verified lowercase address on success, or an AuthError on failure.
 *
 * Security properties:
 *   - Nonces are random 32-byte hex strings — 256 bits of entropy, not guessable.
 *   - Each nonce is usable exactly once (consumeNonce atomically deletes it).
 *   - Nonces expire after 5 minutes regardless of use.
 *   - The server recovers the signer from the signature; it never trusts the
 *     client-supplied address alone.
 *   - The signed message includes the nonce and the claimed wallet address, preventing
 *     a captured signature from being replayed against a different address.
 *
 * Known limitations (in-process only):
 *   - The nonce store is in-memory and is lost on process restart. Clients whose in-flight
 *     nonce was issued before a restart must request a new one. This is a UX concern, not
 *     a security one — an expired/missing nonce is rejected with 401 and the client retries.
 *   - In a multi-process or multi-instance deployment, nonces issued by one process are
 *     unknown to the others. All instances must share a Redis/DB nonce store before scaling
 *     beyond a single process. This is documented in AGENTS.md.
 *   - The nonce TTL timer is wall-clock time inside a single Node/Bun process. If the
 *     process is heavily paused (e.g. container freeze), a nonce that should have expired
 *     may still appear valid. The 5-minute window keeps the practical exposure minimal.
 */

import { randomBytes } from 'crypto'
import { recoverMessageAddress, type Address } from 'viem'

// ── Constants ────────────────────────────────────────────────────────────────

/** Nonces expire after this many milliseconds. 5 minutes. */
export const NONCE_TTL_MS = 5 * 60 * 1000

/**
 * Human-readable prefix prepended to nonces before signing.
 * The full signed message is: NONCE_MESSAGE_PREFIX + nonce + "\nWallet: " + address
 * Including the wallet address in the message prevents a valid signature for wallet A
 * being replayed against wallet B's quota.
 */
export const NONCE_MESSAGE_PREFIX = 'InferMesh authentication nonce:\n'

// ── Nonce store ──────────────────────────────────────────────────────────────

interface NonceEntry {
  wallet: string       // lowercase address this nonce was issued for
  expiresAt: number    // ms timestamp
}

/**
 * In-memory nonce store. Maps nonce string → NonceEntry.
 * Exported for testing (allows white-box inspection).
 */
export const nonceStore = new Map<string, NonceEntry>()

/**
 * Generate and store a single-use nonce for the given wallet address.
 * The wallet must already be format-validated (lowercase 0x+40hex).
 * Returns the nonce string (32 random hex bytes = 64 chars).
 */
export function generateNonce(wallet: string, now = Date.now()): string {
  const nonce = randomBytes(32).toString('hex')
  nonceStore.set(nonce, { wallet, expiresAt: now + NONCE_TTL_MS })
  // Opportunistically prune expired entries to prevent unbounded growth.
  // We only prune on nonce generation (low frequency) to avoid a scan on
  // every auth check (high frequency).
  pruneExpired(now)
  return nonce
}

/**
 * Atomically consume a nonce: returns the NonceEntry if valid and not expired,
 * then deletes it. Returns null if unknown, expired, or issued for a different wallet.
 *
 * "Consume" means: even if this function returns null (e.g. expired), the nonce
 * is deleted if it was present. This prevents a timing-window retry after expiry.
 */
export function consumeNonce(nonce: string, wallet: string, now = Date.now()): NonceEntry | null {
  const entry = nonceStore.get(nonce)
  nonceStore.delete(nonce)  // always delete — no second chance even on failure

  if (!entry) return null
  if (now > entry.expiresAt) return null
  if (entry.wallet !== wallet) return null  // nonce was issued for a different wallet

  return entry
}

/** Remove all expired entries. Called opportunistically on nonce generation. */
function pruneExpired(now: number): void {
  for (const [nonce, entry] of nonceStore) {
    if (now > entry.expiresAt) nonceStore.delete(nonce)
  }
}

/** For testing — clear all nonces. */
export function resetNonceStore(): void { nonceStore.clear() }

// ── Auth error ───────────────────────────────────────────────────────────────

export type AuthErrorCode =
  | 'missing_headers'
  | 'invalid_wallet'
  | 'invalid_nonce'          // not found or expired
  | 'nonce_wallet_mismatch'  // nonce was issued for a different wallet
  | 'invalid_signature'      // signature does not parse or is wrong length
  | 'signature_mismatch'     // recovered address ≠ claimed address

export interface AuthError {
  code: AuthErrorCode
  message: string
}

export interface AuthSuccess {
  wallet: string  // verified lowercase address
  nonce: string   // for logging/audit only; already consumed
}

export type AuthResult =
  | { ok: true;  value: AuthSuccess }
  | { ok: false; error: AuthError }

// ── Canonical signed message ─────────────────────────────────────────────────

/**
 * Returns the exact string the client must sign with personal_sign / eth_sign.
 * Changing this format is a breaking change — it must be kept in sync with
 * the frontend's signMessage() call.
 */
export function buildSignedMessage(nonce: string, wallet: string): string {
  return `${NONCE_MESSAGE_PREFIX}${nonce}\nWallet: ${wallet}`
}

// ── Signature verification ───────────────────────────────────────────────────

/**
 * Verify EIP-191 signature headers on an incoming request.
 *
 * Expects:
 *   X-Auth-Wallet:    0x<40 hex chars>   (case-insensitive, normalised to lowercase)
 *   X-Auth-Signature: 0x<130 hex chars>  (65-byte ECDSA sig from personal_sign)
 *   X-Auth-Nonce:     <64 hex chars>     (the nonce returned by GET /nonce)
 *
 * The body `wallet` field is ignored when these headers are present.
 * verifyAuthHeaders() is the ONLY path that produces a verified address.
 */
export async function verifyAuthHeaders(headers: {
  get(name: string): string | null
}, now = Date.now()): Promise<AuthResult> {
  const rawWallet = headers.get('x-auth-wallet') ?? headers.get('X-Auth-Wallet')
  const rawSig    = headers.get('x-auth-signature') ?? headers.get('X-Auth-Signature')
  const rawNonce  = headers.get('x-auth-nonce') ?? headers.get('X-Auth-Nonce')

  if (!rawWallet || !rawSig || !rawNonce) {
    return {
      ok: false,
      error: {
        code: 'missing_headers',
        message: 'Authentication required. Send X-Auth-Wallet, X-Auth-Nonce, and X-Auth-Signature headers. ' +
          'Call GET /nonce?wallet=<address> to obtain a nonce first.',
      },
    }
  }

  // Validate wallet address format
  const walletTrimmed = rawWallet.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletTrimmed)) {
    return {
      ok: false,
      error: { code: 'invalid_wallet', message: 'X-Auth-Wallet must be a valid EVM address (0x + 40 hex chars).' },
    }
  }
  const wallet = walletTrimmed.toLowerCase()

  // Validate nonce format (must be 64 hex chars — 32 random bytes)
  const nonce = rawNonce.trim()
  if (!/^[0-9a-f]{64}$/.test(nonce)) {
    return {
      ok: false,
      error: { code: 'invalid_nonce', message: 'X-Auth-Nonce must be a 64-character lowercase hex string.' },
    }
  }

  // Validate signature format (0x + 130 hex chars = 65 bytes)
  const sig = rawSig.trim()
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    return {
      ok: false,
      error: { code: 'invalid_signature', message: 'X-Auth-Signature must be a 65-byte EIP-191 signature (0x + 130 hex chars).' },
    }
  }

  // Look up the nonce entry WITHOUT consuming it yet.
  // We verify the signature first so that a caller who sends a validly-formatted
  // nonce with a bad signature cannot burn that nonce and deny service to the
  // legitimate owner. Only a request that passes the full signature check consumes
  // the nonce.
  const entry = nonceStore.get(nonce)

  if (!entry) {
    return {
      ok: false,
      error: {
        code: 'invalid_nonce',
        message: 'Nonce is invalid, expired, or already used. Request a new nonce from GET /nonce?wallet=<address>.',
      },
    }
  }

  // Check expiry and wallet binding before touching the sig (cheap checks first)
  if (now > entry.expiresAt) {
    // Prune the expired entry; do not leave stale nonces in the store.
    nonceStore.delete(nonce)
    return {
      ok: false,
      error: {
        code: 'invalid_nonce',
        message: 'Nonce has expired. Request a new nonce from GET /nonce?wallet=<address>.',
      },
    }
  }

  if (entry.wallet !== wallet) {
    // Nonce was issued for a different wallet. Consume it to prevent retries.
    nonceStore.delete(nonce)
    return {
      ok: false,
      error: {
        code: 'invalid_nonce',
        message: 'Nonce is invalid, expired, or already used. Request a new nonce from GET /nonce?wallet=<address>.',
      },
    }
  }

  // Recover signer from the EIP-191 signature — BEFORE consuming the nonce.
  // A bad signature leaves the nonce intact so the legitimate owner can still use it.
  const message = buildSignedMessage(nonce, wallet)
  let recovered: Address
  try {
    recovered = await recoverMessageAddress({
      message,
      signature: sig as `0x${string}`,
    })
  } catch {
    // Malformed signature — do NOT consume the nonce; no DoS possible.
    return {
      ok: false,
      error: { code: 'invalid_signature', message: 'Signature could not be decoded.' },
    }
  }

  if (recovered.toLowerCase() !== wallet) {
    // Wrong signer — do NOT consume the nonce; victim retains their slot.
    return {
      ok: false,
      error: {
        code: 'signature_mismatch',
        message: 'Signature does not match the claimed wallet address. ' +
          'Ensure you are signing with the wallet you specified.',
      },
    }
  }

  // Signature is valid — now atomically consume the nonce to prevent replay.
  // consumeNonce re-checks existence, expiry, and wallet binding; the result
  // cannot differ from the checks above since no other goroutine runs here
  // (single-threaded Bun event loop), but the double-check makes the invariant explicit.
  const consumed = consumeNonce(nonce, wallet, now)
  if (!consumed) {
    // Extremely unlikely: two concurrent requests with the same nonce raced
    // through all checks simultaneously (possible only under heavy load with
    // identical headers). Treat as replay.
    return {
      ok: false,
      error: {
        code: 'invalid_nonce',
        message: 'Nonce is invalid, expired, or already used. Request a new nonce from GET /nonce?wallet=<address>.',
      },
    }
  }

  return { ok: true, value: { wallet, nonce } }
}
