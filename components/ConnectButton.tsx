"use client";

import { DynamicWidget } from "@dynamic-labs/sdk-react-core";

/**
 * Dynamic's widget in the header: the connect button and, once connected, the account/network UI.
 * Clicking it opens the wallet-only modal (searchable wallets, Installed/Multichain badges) — the same
 * experience as relay.link/bridge.
 */
export function ConnectButton() {
  return <DynamicWidget />;
}
