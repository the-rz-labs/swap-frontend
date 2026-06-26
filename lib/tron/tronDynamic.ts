"use client";

import type { TronTransaction } from "./tronGrid";

/**
 * Bridges the Dynamic Tron wallet (a React-context value) to the non-React Relay execution path. A
 * small effect in the UI publishes the current Tron signer here; the Relay {@link tronAdaptedWallet}
 * reads it when it needs to sign a source transaction.
 */
export type TronSigner = {
  address: string;
  /** Sign an unsigned Tron transaction (built by TronGrid) with the connected wallet. */
  sign: (tx: TronTransaction) => Promise<TronTransaction>;
};

let current: TronSigner | undefined;

export function setTronSigner(signer: TronSigner | undefined): void {
  current = signer;
}

export function getTronSigner(): TronSigner | undefined {
  return current;
}

/**
 * Best-effort builder for a {@link TronSigner} from a Dynamic Tron wallet (a `useUserWallets` entry).
 * Dynamic Tron wallets wrap a @tronweb3 adapter and expose a TronWeb instance; signing goes through
 * `tronWeb.trx.sign`, which delegates to the connected wallet. The exact accessor for the TronWeb
 * instance can vary by wallet/version — this tries the known shapes and is the one spot to adjust if
 * live signing fails.
 */
export async function tronSignerFromWallet(wallet: unknown): Promise<TronSigner | undefined> {
  const w = wallet as
    | {
        address?: string;
        getTronWeb?: () => Promise<TronWebLike> | TronWebLike;
        connector?: { getTronWeb?: () => Promise<TronWebLike> | TronWebLike };
      }
    | undefined;
  if (!w?.address) return undefined;
  const getTronWeb = w.getTronWeb?.bind(w) ?? w.connector?.getTronWeb?.bind(w.connector);
  if (!getTronWeb) return undefined;
  const address = w.address;
  return {
    address,
    sign: async (tx) => {
      const tronWeb = await getTronWeb();
      return tronWeb.trx.sign(tx) as Promise<TronTransaction>;
    },
  };
}

type TronWebLike = { trx: { sign: (tx: TronTransaction) => Promise<TronTransaction> | TronTransaction } };
