"use client";

import { type ReactNode, useEffect, useState } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { TronWalletConnectors } from "@dynamic-labs/tron";
import { DynamicWagmiConnector } from "@dynamic-labs/wagmi-connector";
import { wagmiConfig, ETH_RPC } from "@/lib/wagmi";
import { installRelayRejectionGuard } from "@/lib/relayErrors";

const queryClient = new QueryClient();

const DYNAMIC_ENV_ID = process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID ?? "";

if (!DYNAMIC_ENV_ID) {
  // eslint-disable-next-line no-console
  console.warn(
    "[rzswap] NEXT_PUBLIC_DYNAMIC_ENV_ID is not set — the wallet modal won't connect. Create a free " +
      "environment at https://app.dynamic.xyz. On-chain reads still work via the explicit RPCs.",
  );
}

/**
 * Dynamic.xyz powers the multichain wallet modal (the same kit relay.link/bridge uses): EVM + Tron in
 * one "Log in or sign up" flow. DynamicWagmiConnector bridges the connected EVM wallet into wagmi, so
 * the rest of the app (getWalletClient, balances, contract calls) is unchanged.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    installRelayRejectionGuard();
  }, []);

  // Render nothing on the server and the first client paint: Dynamic injects wallet-SDK styles only on
  // the client, so deferring to after mount keeps SSR and the first render identical (no hydration
  // mismatch). This is a client-rendered dApp, so there's no SSR content to lose.
  if (!mounted) return null;

  return (
    <DynamicContextProvider
      theme="dark"
      locale={{
        en: {
          // Rename the default "Log in or sign up" copy to "Connect Wallet" (modal title + widget button).
          dyn_login: {
            title: { all: "Connect Wallet", all_wallet_list: "Connect Wallet", wallet_only: "Connect Wallet" },
          },
          dyn_widget: { connect: "Connect Wallet" },
        },
      }}
      settings={{
        environmentId: DYNAMIC_ENV_ID,
        walletConnectors: [EthereumWalletConnectors, TronWalletConnectors],
        appName: "RzSwap",
        // Wallet-connect-only, like relay.link/bridge — no email/social "log in or sign up" account
        // flow and no sign-in message; just connect a wallet.
        initialAuthenticationMode: "connect-only",
        // Show ONLY the wallet list in the modal (no email / social sections).
        overrides: {
          views: [{ type: "wallet-list" }],
          // Declare the EVM networks we use so Dynamic can switch the wallet to BNB Chain (it errors
          // "Could not find network mapping for chain 56" if BSC isn't registered).
          evmNetworks: [
            {
              blockExplorerUrls: ["https://bscscan.com"],
              chainId: 56,
              chainName: "BNB Smart Chain",
              iconUrls: ["https://app.dynamic.xyz/assets/networks/bnb.svg"],
              name: "BNB Chain",
              nativeCurrency: { decimals: 18, name: "BNB", symbol: "BNB" },
              networkId: 56,
              rpcUrls: [process.env.NEXT_PUBLIC_BSC_RPC || "https://bsc-dataseed.bnbchain.org"],
              vanityName: "BNB Chain",
            },
            {
              blockExplorerUrls: ["https://etherscan.io"],
              chainId: 1,
              chainName: "Ethereum",
              iconUrls: ["https://app.dynamic.xyz/assets/networks/eth.svg"],
              name: "Ethereum",
              nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
              networkId: 1,
              // Prefer publicnode — MetaMask may ignore this for the built-in Ethereum network and keep
              // a gated custom RPC (Ankr Unauthorized); see friendlyRelayError for the user hint.
              rpcUrls: [ETH_RPC, "https://ethereum.publicnode.com", "https://1rpc.io/eth"],
              vanityName: "Ethereum",
            },
          ],
        },
      }}
    >
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <DynamicWagmiConnector>{children}</DynamicWagmiConnector>
        </QueryClientProvider>
      </WagmiProvider>
    </DynamicContextProvider>
  );
}
