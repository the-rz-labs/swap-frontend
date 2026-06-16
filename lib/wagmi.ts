import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { bsc, mainnet, arbitrum, base, optimism, polygon } from "@reown/appkit/networks";
import type { AppKitNetwork } from "@reown/appkit/networks";

export const REOWN_PROJECT_ID = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";

if (!REOWN_PROJECT_ID) {
  // Surface a clear message during development instead of a cryptic WalletConnect error.
  console.warn("[rzswap] NEXT_PUBLIC_REOWN_PROJECT_ID is not set — wallet connection will fail.");
}

/**
 * BSC is the hub chain (our RzSwap contract lives here). The remaining chains are cross-chain
 * origins/destinations reachable through Relay. BSC is intentionally first so AppKit defaults to it.
 */
export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [
  bsc,
  mainnet,
  arbitrum,
  base,
  optimism,
  polygon,
];

export const BSC_CHAIN_ID = bsc.id; // 56

export const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId: REOWN_PROJECT_ID,
  ssr: true,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
