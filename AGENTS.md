# InferMesh

AI inference marketplace on Arc Mainnet. Powered by the Orbio gateway (OpenAI-compatible).

## Architecture

- **Frontend**: Vite + React + TypeScript on port 5173
- **Backend**: Bun HTTP server on port 3001 (`server/index.ts`)
- **Database**: SQLite at `.data/infermesh.db` (auto-created)
- **Inference**: Orbio gateway at `https://api.orbio.so/api/v1`

## Environment Variables

Add to `.env`:

```
ORBIO_API_KEY=sk-orbio-xxxxxxxxxxxx
```

Get an API key at https://orbio.so. Without it the server starts but inference returns a 503.

## Chain

- **Target**: Arc Mainnet (chain ID 5042)
- **USDC contract**: `0x3600000000000000000000000000000000000000`
- **Explorer**: https://explorer.arc.io
- **RPC**: https://rpc.mainnet.arc.io

## Payment Architecture

USDC payment integration is designed but not yet deployed:
- Users will deposit USDC into an escrow contract
- Per-request deductions will happen on-chain
- Requires explicit approval before contract deployment
- Current sessions use server-side Orbio billing

## Backend Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | Server health + API key status + quota config |
| `/models` | GET | Proxy Orbio model catalogue |
| `/chat` | POST | Run inference, record usage — quota-gated |
| `/quota` | GET | Per-wallet quota status (`?wallet=0x...`) |
| `/usage` | GET | List usage records |
| `/usage/stats` | GET | Summary stats |
| `/usage/:id` | GET | Single record detail |

## Phase 1 Free-Tier Limits (configurable via .env)

| Variable | Default | Description |
|---|---|---|
| `FREE_DAILY_REQUESTS` | 10 | Max successful requests per wallet per day |
| `FREE_DAILY_TOKENS` | 50000 | Max tokens (in+out) per wallet per day |
| `FREE_RPM` | 3 | Max requests per wallet per 60-second window |
| `GLOBAL_DAILY_REQUESTS` | 500 | Global circuit-breaker: requests across all wallets |
| `GLOBAL_DAILY_TOKENS` | 2000000 | Global circuit-breaker: tokens across all wallets |

HTTP status codes: 402 quota exhausted, 429 rate limited / concurrent, 503 global circuit-breaker.
Identity: wallet address format-validated only (Phase 1). EIP-191 signature verification deferred to Phase 2.

## Deployed Contracts

None yet. Payment contract pending explicit approval (Phase 3).
