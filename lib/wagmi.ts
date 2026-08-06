import { createConfig, fallback, http } from "wagmi";
import { bsc, mainnet } from "wagmi/chains";

/**
 * Plain wagmi config driven by Dynamic.xyz (the wallet modal Relay's bridge uses). Dynamic injects the
 * connectors via <DynamicWagmiConnector>, so we declare none here and disable wagmi's own injected
 * discovery. EVM reads/writes (getWalletClient, readContract, balances) keep working unchanged.
 */
export const BSC_CHAIN_ID = bsc.id; // 56

const BSC_RPC = process.env.NEXT_PUBLIC_BSC_RPC || "https://bsc-dataseed.bnbchain.org";
/** Primary + public fallbacks — wallet RPCs (e.g. MetaMask→Ankr) are separate and may still need a manual fix. */
export const ETH_RPC = process.env.NEXT_PUBLIC_ETH_RPC || "https://ethereum.publicnode.com";
const ETH_RPC_FALLBACKS = [
  ETH_RPC,
  "https://ethereum.publicnode.com",
  "https://ethereum-rpc.publicnode.com",
  "https://1rpc.io/eth",
  "https://cloudflare-eth.com",
].filter((u, i, a) => a.indexOf(u) === i);

export const wagmiConfig = createConfig({
  chains: [bsc, mainnet],
  multiInjectedProviderDiscovery: false,
  ssr: true,
  transports: {
    [bsc.id]: http(BSC_RPC),
    [mainnet.id]: fallback(ETH_RPC_FALLBACKS.map((url) => http(url))),
  },
});

/** The chain ids wagmi is configured for (BSC, Ethereum). Used to satisfy wagmi's strict chainId typing
 *  at call sites that carry a generic `number` (always an EVM chain on those paths). */
export type AppChainId = (typeof wagmiConfig)["chains"][number]["id"];
