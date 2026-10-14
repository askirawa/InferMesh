# InferMesh

**AI Inference Marketplace on Arc Mainnet**

InferMesh is a streamlined platform for discovering, comparing, and running AI models via the Orbio inference gateway. It is built on Arc Mainnet, where USDC is the native gas token.

---

## What It Does

| Feature | Status |
|---------|--------|
| Model catalogue from Orbio gateway | Live |
| AI playground with real inference | Live (requires `ORBIO_API_KEY`) |
| Persistent usage history (SQLite) | Live |
| Arc Mainnet wallet + USDC balance | Live |
| USDC payment contract | Pending explicit approval |

---

## Quick Start

### 1. Add your Orbio API key

```bash
# .env
ORBIO_API_KEY=sk-orbio-xxxxxxxxxxxx
```

Get a key at [orbio.so](https://orbio.so). The server starts without it but inference returns a 503.

### 2. Start the backend

```bash
bun run server
```

Runs on `http://localhost:3001`. Creates `.data/infermesh.db` on first run.

### 3. Start the frontend

```bash
bun run dev
```

Vite proxies `/api/*` to the backend automatically.

---

## Architecture

```
browser (Vite + React + wagmi)
    │
    ├── /api/* ──> Bun HTTP server (server/index.ts, port 3001)
    │                   │
    │                   ├── SQLite (.data/infermesh.db)
    │                   └── Orbio gateway (https://api.orbio.so/api/v1)
    │
    └── wagmi / ConnectKit ──> Arc Mainnet RPC
```

### Frontend pages

- **Dashboard** — request count, token usage, recent activity
- **Explore Models** — live catalogue from Orbio, search + filter
- **Playground** — real chat UI with latency + token telemetry
- **Usage** — paginated history with full request/response detail
- **Wallet** — Arc Mainnet address, USDC balance, network switcher

### Backend routes

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | `{ ok, hasApiKey }` |
| `/models` | GET | Proxied Orbio model list |
| `/chat` | POST | Run inference, record to DB |
| `/usage` | GET | Paginated usage records |
| `/usage/stats` | GET | Summary stats |
| `/usage/:id` | GET | Full record with prompt/response |

---

## Chain Configuration

| Field | Value |
|-------|-------|
| Chain | Arc Mainnet |
| Chain ID | 5042 |
| RPC | https://rpc.mainnet.arc.io |
| Explorer | https://explorer.arc.io |
| Gas token | USDC (native, 18 dec) |
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` (6 dec) |

Arc uses USDC as its native gas token. On Arc, `useBalance` returns the same USDC pool as the ERC-20 `balanceOf`. InferMesh shows only the ERC-20 (6-decimal) view to avoid double-counting.

---

## Payment Architecture

InferMesh is designed for USDC micropayments on Arc. The intended flow:

1. User deposits USDC into an InferMesh escrow contract
2. Each inference request deducts USDC from the escrow
3. Deducted funds are forwarded to the Orbio funding address

**This contract has not been deployed.** Deployment requires explicit approval because it handles real USDC on Arc Mainnet. Current inference is billed server-side through the Orbio API key.

---

## Adding More Providers

The backend's `/chat` route is provider-agnostic. To add a new provider:

1. Add its env variables to `.env`
2. In `server/index.ts`, check `body.provider` and route to the new endpoint
3. Return the same `ChatResponse` shape

---

## Security Notes

- `ORBIO_API_KEY` lives only in the server environment — never sent to the browser
- Prompts and responses are stored locally in SQLite only — not forwarded anywhere beyond Orbio
- Orbio has zero data retention on inference routes (prompts never stored at provider)
- Never share or commit your `.env` file
