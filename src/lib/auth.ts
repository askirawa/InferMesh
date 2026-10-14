/**
 * src/lib/auth.ts — Frontend authentication state for InferMesh
 *
 * The `useAuth` hook manages EIP-191 wallet ownership verification.
 *
 * Flow (per wallet connection):
 *   1. Wallet connects (wagmi `useAccount`).
 *   2. `useAuth` automatically fetches a fresh nonce from GET /nonce?wallet=<address>.
 *   3. On the first request that needs auth, `getAuthHeaders()` is called.
 *      It signs the nonce message with `signMessageAsync` (wagmi), returning
 *      the three auth headers the server expects.
 *   4. The signed headers are cached per (wallet, nonce) so subsequent requests
 *      within the same nonce window avoid re-prompting the user. Because the server
 *      consumes the nonce on the first use, only one request can use a given signature.
 *      Subsequent calls automatically fetch a fresh nonce and sign it.
 *   5. On 401 (expired or replayed nonce), the caller should call `invalidate()` to
 *      clear the cached nonce and trigger a re-sign on the next request.
 *   6. On wallet change or disconnect, all state is cleared.
 *
 * Design decisions:
 *   - Nonces are fetched eagerly on wallet connect so the first request can sign
 *     immediately without an extra round trip.
 *   - The sign prompt is lazy: it fires when the user actually sends a request,
 *     not at wallet connect. This avoids prompting users who just want to browse.
 *   - The hook never stores the private key or the signed message; it only stores
 *     the nonce value (not sensitive) and the resulting signature (which, once the
 *     nonce is consumed, cannot be replayed).
 *   - Auth headers are sent for every /chat and /quota call. The server rejects any
 *     request without valid headers regardless of body content.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAccount, useSignMessage } from 'wagmi'

// Matches server's buildSignedMessage() in server/auth.ts — kept in sync manually.
const NONCE_MESSAGE_PREFIX = 'InferMesh authentication nonce:\n'

export function buildSignedMessage(nonce: string, wallet: string): string {
  return `${NONCE_MESSAGE_PREFIX}${nonce}\nWallet: ${wallet}`
}

export interface AuthHeaders {
  'X-Auth-Wallet': string
  'X-Auth-Nonce': string
  'X-Auth-Signature': string
}

export type AuthState =
  | { status: 'disconnected' }
  | { status: 'fetching_nonce' }
  | { status: 'ready'; nonce: string }          // nonce fetched, not yet signed
  | { status: 'signing' }                        // waiting for wallet to sign
  | { status: 'signed'; nonce: string; sig: string }  // signed, reusable until consumed
  | { status: 'error'; message: string }

export interface UseAuthReturn {
  authState: AuthState
  /**
   * Returns the three auth headers needed for /chat and /quota.
   * On first call (or after nonce consumption), prompts the user to sign.
   * Throws if the wallet is disconnected, the nonce fetch fails, or the user
   * rejects the sign prompt.
   */
  getAuthHeaders: () => Promise<AuthHeaders>
  /**
   * Call when the server returns 401 (nonce consumed or expired).
   * Clears the cached signature and fetches a fresh nonce.
   */
  invalidate: () => void
  /** True while the nonce is being fetched or the user is signing. */
  isAuthenticating: boolean
}

export function useAuth(): UseAuthReturn {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const [authState, setAuthState] = useState<AuthState>({ status: 'disconnected' })

  // Keep a stable ref to the current state for use inside callbacks without
  // triggering infinite re-render loops.
  const stateRef = useRef<AuthState>({ status: 'disconnected' })
  stateRef.current = authState

  // In-progress nonce fetch — prevents duplicate parallel fetches
  const nonceFetchRef = useRef<Promise<string> | null>(null)

  // In-progress sign — prevents duplicate sign prompts
  const signPromiseRef = useRef<Promise<AuthHeaders> | null>(null)

  /** Fetch a nonce from the server for the current wallet. */
  const fetchNonce = useCallback(async (wallet: string): Promise<string> => {
    const res = await fetch(`/api/nonce?wallet=${encodeURIComponent(wallet)}`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { message?: string }
      throw new Error(err.message ?? `Nonce fetch failed: HTTP ${res.status}`)
    }
    const data = await res.json() as { nonce: string }
    return data.nonce
  }, [])

  /** Eagerly fetch a nonce when wallet connects. */
  useEffect(() => {
    if (!address) {
      setAuthState({ status: 'disconnected' })
      nonceFetchRef.current = null
      signPromiseRef.current = null
      return
    }

    const wallet = address.toLowerCase()
    setAuthState({ status: 'fetching_nonce' })

    const p = fetchNonce(wallet)
    nonceFetchRef.current = p

    p.then((nonce) => {
      // Only update if this is still the active address and promise
      if (nonceFetchRef.current === p) {
        setAuthState({ status: 'ready', nonce })
      }
    }).catch((err: unknown) => {
      if (nonceFetchRef.current === p) {
        setAuthState({ status: 'error', message: String(err) })
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  const invalidate = useCallback(() => {
    if (!address) return
    const wallet = address.toLowerCase()
    signPromiseRef.current = null
    setAuthState({ status: 'fetching_nonce' })
    const p = fetchNonce(wallet)
    nonceFetchRef.current = p
    p.then((nonce) => {
      if (nonceFetchRef.current === p) setAuthState({ status: 'ready', nonce })
    }).catch((err: unknown) => {
      if (nonceFetchRef.current === p) {
        setAuthState({ status: 'error', message: String(err) })
      }
    })
  }, [address, fetchNonce])

  const getAuthHeaders = useCallback(async (): Promise<AuthHeaders> => {
    if (!address) throw new Error('Wallet not connected. Connect your wallet before sending a request.')

    const wallet = address.toLowerCase()
    const state = stateRef.current

    // If we already have a valid signature cached, return it immediately.
    // The server will consume the nonce on first use; subsequent calls to
    // getAuthHeaders() after a 401 should go through invalidate() first.
    if (state.status === 'signed') {
      return {
        'X-Auth-Wallet': wallet,
        'X-Auth-Nonce': state.nonce,
        'X-Auth-Signature': state.sig,
      }
    }

    // If a sign is already in progress (e.g. two parallel calls), wait for it
    if (signPromiseRef.current) return signPromiseRef.current

    const doSign = async (): Promise<AuthHeaders> => {
      // Get the nonce — wait for fetch if still in progress
      let nonce: string
      if (state.status === 'ready') {
        nonce = state.nonce
      } else if (state.status === 'fetching_nonce' && nonceFetchRef.current) {
        nonce = await nonceFetchRef.current
      } else {
        // Fetch a fresh nonce
        setAuthState({ status: 'fetching_nonce' })
        nonce = await fetchNonce(wallet)
        nonceFetchRef.current = Promise.resolve(nonce)
      }

      setAuthState({ status: 'signing' })
      const message = buildSignedMessage(nonce, wallet)

      let sig: string
      try {
        sig = await signMessageAsync({ message })
      } catch (_err) {
        // User rejected or wallet error — restore to 'ready' so they can retry
        setAuthState({ status: 'ready', nonce })
        throw new Error('Signature rejected. Please approve the sign request in your wallet to continue.')
      }

      setAuthState({ status: 'signed', nonce, sig })
      return {
        'X-Auth-Wallet': wallet,
        'X-Auth-Nonce': nonce,
        'X-Auth-Signature': sig,
      }
    }

    const p = doSign()
    signPromiseRef.current = p
    p.catch(() => {
      signPromiseRef.current = null
    })
    return p
  }, [address, fetchNonce, signMessageAsync])

  const isAuthenticating = authState.status === 'fetching_nonce' || authState.status === 'signing'

  return { authState, getAuthHeaders, invalidate, isAuthenticating }
}
