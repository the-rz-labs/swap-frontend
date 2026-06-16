"use client";

import { type ReactNode, useEffect } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit } from "@reown/appkit/react";
import { wagmiAdapter, wagmiConfig, networks, REOWN_PROJECT_ID } from "@/lib/wagmi";
import { installRelayRejectionGuard } from "@/lib/relayErrors";

const queryClient = new QueryClient();

// Initialise Reown AppKit once at module load (client only).
createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId: REOWN_PROJECT_ID,
  defaultNetwork: networks[0],
  metadata: {
    name: "RzSwap",
    description: "Cross-chain swaps into the RZ ecosystem on BNB Chain",
    url: typeof window !== "undefined" ? window.location.origin : "https://rzswap.app",
    icons: ["https://avatars.githubusercontent.com/u/179229932"],
  },
  features: {
    analytics: false,
    email: false,
    socials: [],
  },
  themeMode: "dark",
});

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    installRelayRejectionGuard();
  }, []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
