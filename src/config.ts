/**
 * wagmi configuration — Arc Mainnet + Ethereum (for ENS)
 * InferMesh targets Arc Mainnet (chain ID 5042).
 *
 * Uses ConnectKit's getDefaultConfig to register real connectors:
 *   - injected({ target: 'metaMask' })   — MetaMask browser extension (desktop)
 *   - coinbaseWallet                     — Coinbase Wallet SDK
 *   - walletConnect                      — WC v2 QR code (requires project ID)
 *   - safe                               — Gnosis Safe (auto-added in iframes)
 *
 * WalletConnect requires VITE_WALLETCONNECT_PROJECT_ID in .env.
 * Without it the WC connector is silently omitted by ConnectKit's
 * defaultConnectors — MetaMask and Coinbase are still registered.
 *
 * Connection paths per environment:
 *   Desktop (extension present)  → MetaMask injected connector
 *   Mobile / iframe              → WalletConnect QR code (requires project ID)
 *   Arc Studio preview (iframe)  → WalletConnect QR code only
 *
 * To obtain a free project ID:
 *   1. Sign in at https://cloud.walletconnect.com
 *   2. Create a project (type: Web3Modal or WalletKit)
 *   3. Copy the Project ID and add it to .env as VITE_WALLETCONNECT_PROJECT_ID
 */
import { createConfig, http } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc } from 'viem/chains'
import { getDefaultConfig } from 'connectkit'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names
registerChain(arc.id, arc.rpcUrls.default.http[0])

export const ARC_MAINNET_ID = arc.id // 5042

// Read and validate the WalletConnect project ID.
// ConnectKit requires this field typed as `string` but skips the WC connector
// when the value is falsy — so an absent env var silently degrades to
// MetaMask/Coinbase only rather than crashing at startup.
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined

if (!walletConnectProjectId) {
  // Warn at dev-time; production builds should always have the variable set.
  console.warn(
    '[InferMesh] VITE_WALLETCONNECT_PROJECT_ID is not set. ' +
    'WalletConnect QR code (required for mobile and iframe contexts) will not be available. ' +
    'Add the variable to .env and restart the dev server.',
  )
}

export const config = createConfig(
  getDefaultConfig({
    appName: 'InferMesh',
    appDescription: 'AI inference marketplace on Arc',
    appUrl: 'https://infermesh.arc.io',
    // Passing '' is safe: ConnectKit only adds the WC connector when this is truthy.
    // We never treat an empty string as a valid project ID.
    walletConnectProjectId: walletConnectProjectId ?? '',
    chains: [arc, mainnet],
    // Explicit transports so Arc Mainnet uses the official RPC rather than the
    // auto-generated public fallback from getDefaultConfig.
    transports: {
      [arc.id]: http(),
      [mainnet.id]: http(),
    },
  }),
)
