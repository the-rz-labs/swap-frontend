import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { bsc, mainnet } from "@reown/appkit/networks";
import type { AppKitNetwork } from "@reown/appkit/networks";
import { http } from "viem";

export const REOWN_PROJECT_ID = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";

if (!REOWN_PROJECT_ID || REOWN_PROJECT_ID.startsWith("REPLACE")) {
  // Surface a clear message during development instead of a cryptic 401/403 from WalletConnect.
  console.warn(
    "[rzswap] NEXT_PUBLIC_REOWN_PROJECT_ID is not set to a real id — wallet connection (and chain " +
      "logos) will fail. Get one at https://dashboard.reown.com. On-chain reads still work via the " +
      "explicit RPCs below.",
  );
}

/**
 * BSC is the hub chain (our RzSwap contract lives here); Ethereum is the cross-chain origin/
 * destination reachable through Relay. BSC is first so AppKit defaults to it.
 */
export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [bsc, mainnet];

export const BSC_CHAIN_ID = bsc.id; // 56

// Explicit public RPCs for reads (balances, quotes) — independent of the WalletConnect RPC, which
// requires a valid projectId and rate-limits. Overridable via env.
const BSC_RPC = process.env.NEXT_PUBLIC_BSC_RPC || "https://bsc-dataseed.bnbchain.org";
const ETH_RPC = process.env.NEXT_PUBLIC_ETH_RPC || "https://ethereum-rpc.publicnode.com";

export const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId: REOWN_PROJECT_ID,
  ssr: true,
  transports: {
    [bsc.id]: http(BSC_RPC),
    [mainnet.id]: http(ETH_RPC),
  },
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
