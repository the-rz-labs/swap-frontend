"use client";

import { useAppKit, useAppKitAccount } from "@reown/appkit/react";
import { shortHash } from "@/lib/format";

export function ConnectButton() {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();

  return (
    <button
      onClick={() => open()}
      className="rounded-xl2 bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accentHover"
    >
      {isConnected && address ? shortHash(address) : "Connect Wallet"}
    </button>
  );
}
