/**
 * API client — thin wrappers around the backend proxy routes.
 */

const BASE = '/api'

export interface OrbioModelPricing {
  /** Cost per token as a decimal string, e.g. "0.000003" */
  prompt?: string
  /** Cost per token as a decimal string — "0" means genuinely free */
  completion?: string
  unit?: number
  /** Web search surcharge per call */
  web_search?: string
  /** Cache read discount */
  input_cache_read?: string
  input_cache_write?: string
  /** Tiered pricing overrides above a token threshold */
  overrides?: Array<{
    min_prompt_tokens?: number
    prompt?: string
    completion?: string
  }>
}

export interface OrbioModelArchitecture {
  modality?: string
  input_modalities?: string[]
  output_modalities?: string[]
  tokenizer?: string
  instruct_type?: string | null
}

export interface OrbioModel {
  id: string
  object: string
  /** Human-readable display name provided by Orbio, always present */
  name?: string
  owned_by?: string
  created?: number
  context_length?: number
  pricing?: OrbioModelPricing
  top_provider?: {
    context_length?: number
    max_completion_tokens?: number
    is_moderated?: boolean
  }
  per_request_limits?: Record<string, string>
  description?: string
  architecture?: OrbioModelArchitecture
  /** Legacy capabilities array — superseded by architecture.input_modalities */
  capabilities?: string[]
  supported_parameters?: string[]
}

export interface ModelsResponse {
  object?: string
  data?: OrbioModel[]
}

export interface AuthHeaders {
  'X-Auth-Wallet': string
  'X-Auth-Nonce': string
  'X-Auth-Signature': string
}

export interface NonceResponse {
  nonce: string
  wallet: string
  message: string
  expires_in_seconds: number
}

export interface ChatRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  /** @deprecated Body wallet is ignored by the server; use auth headers instead */
  wallet?: string
  max_tokens?: number
  temperature?: number
}

export interface QuotaInfo {
  used_requests: number
  limit_requests: number
  used_tokens: number
  limit_tokens: number
  resets_at: number
}

export interface QuotaStatus extends QuotaInfo {
  wallet: string
  allowed: boolean
  reason?: string | null
  global_circuit_breaker_tripped: boolean
  global_reason?: string | null
  identity_verified: boolean
}

export interface ChatResponse {
  id: string
  model: string
  response: string
  usage: {
    input_tokens: number | null
    output_tokens: number | null
  }
  latency_ms: number
  balance_after: string | null
  finish_reason: string | null
  quota?: QuotaInfo
}

export interface UsageRecord {
  id: string
  model_id: string
  provider: string
  prompt?: string
  response?: string
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  latency_ms: number | null
  status: 'pending' | 'success' | 'error'
  error?: string | null
  wallet: string | null
  created_at: number
}

export interface UsageListResponse {
  records: UsageRecord[]
  total: number
  limit: number
  offset: number
}

export interface UsageStats {
  total_requests: number
  total_tokens: number | null
  total_cost_usd: number | null
  recent: Array<{
    id: string
    model_id: string
    status: string
    latency_ms: number | null
    created_at: number
  }>
}

export interface HealthResponse {
  ok: boolean
  hasApiKey: boolean
  quota?: {
    freeDailyRequests: number
    freeDailyTokens: number
    freeRpm: number
    globalDailyRequests: number
    globalDailyTokens: number
  }
}

/**
 * Auth error response from the server.
 * HTTP 401 is returned when auth headers are missing, expired, or invalid.
 */
export interface AuthErrorResponse {
  error: string
  message: string
  /** True when the error is specifically an auth failure (401) */
  isAuthError: boolean
}

async function get<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: extraHeaders ?? {},
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; message?: string }
    const e = new Error(err.message ?? err.error ?? `HTTP ${res.status}`) as Error & { status?: number; code?: string }
    e.status = res.status
    e.code = err.error
    throw e
  }
  return res.json() as Promise<T>
}

async function post<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
  const data = await res.json() as T & { error?: string; message?: string }
  if (!res.ok) {
    const msg = (data as { message?: string; error?: string }).message
      ?? (data as { error?: string }).error
      ?? `HTTP ${res.status}`
    const e = new Error(msg) as Error & { status?: number; code?: string }
    e.status = res.status
    e.code = (data as { error?: string }).error
    throw e
  }
  return data
}

export const api = {
  health: () => get<HealthResponse>('/health'),
  models: () => get<ModelsResponse>('/models'),

  /** Fetch a single-use nonce for the given wallet address. No auth required. */
  nonce: (wallet: string) => get<NonceResponse>(`/nonce?wallet=${encodeURIComponent(wallet)}`),

  /**
   * Send a chat request. Requires auth headers (X-Auth-Wallet, X-Auth-Nonce, X-Auth-Signature).
   * The body `wallet` field is ignored by the server; wallet comes from X-Auth-Wallet.
   * On 401, invalidate the auth state and retry with a fresh nonce.
   */
  chat: (req: ChatRequest, authHeaders: AuthHeaders) =>
    post<ChatResponse>('/chat', req, authHeaders as unknown as Record<string, string>),

  /**
   * Get per-wallet quota status. Requires auth headers.
   * Returns identity_verified: true when the signature was valid.
   */
  quota: (authHeaders: AuthHeaders) =>
    get<QuotaStatus>(`/quota`, authHeaders as unknown as Record<string, string>),

  usage: (params?: { limit?: number; offset?: number; wallet?: string }) => {
    const qs = new URLSearchParams()
    if (params?.limit) qs.set('limit', String(params.limit))
    if (params?.offset) qs.set('offset', String(params.offset))
    if (params?.wallet) qs.set('wallet', params.wallet)
    return get<UsageListResponse>(`/usage?${qs}`)
  },
  usageRecord: (id: string) => get<UsageRecord>(`/usage/${id}`),
  usageStats: (wallet?: string) => {
    const qs = wallet ? `?wallet=${encodeURIComponent(wallet)}` : ''
    return get<UsageStats>(`/usage/stats${qs}`)
  },
}
