import {
  createClient,
  getClient,
  MAINNET_RELAY_API,
  convertViemChainToRelayChain,
  getQuote as sdkGetQuote,
  execute as sdkExecute,
} from "@reservoir0x/relay-sdk";
import { bsc, mainnet, arbitrum, base, optimism, polygon } from "viem/chains";
import type { WalletClient } from "viem";
import type { Execute, ProgressData } from "@reservoir0x/relay-sdk";

let initialized = false;

/** Lazily configure the Relay client once (idempotent). */
export function ensureRelay() {
  if (initialized) return getClient();
  createClient({
    baseApiUrl: MAINNET_RELAY_API,
    source: process.env.NEXT_PUBLIC_RELAY_SOURCE ?? "rzswap.app",
    chains: [bsc, mainnet, arbitrum, base, optimism, polygon].map(convertViemChainToRelayChain),
  });
  initialized = true;
  return getClient();
}

/** A raw destination-chain call Relay executes via its multicaller after the bridge fills. */
export type RelayCallTx = { to: string; value?: string; data: string };

export type RelayQuoteInput = {
  fromChainId: number;
  fromCurrency: string; // token address, or zero address for native
  toChainId: number;
  toCurrency: string;
  /** Input amount in base units (wei) — EXACT_INPUT. */
  amount: string;
  /** Destination recipient (defaults to the connected user). */
  recipient?: string;
  wallet?: WalletClient;
  /** Destination-chain calls to run as part of the fill (bridge-and-execute). */
  txs?: RelayCallTx[];
  /** Refund on the origin chain if the destination execution can't complete. */
  refundOnOrigin?: boolean;
};

/** Fetches a Relay EXACT_INPUT quote. Wallet is optional for read-only estimates. */
export async function getRelayQuote(input: RelayQuoteInput): Promise<Execute> {
  ensureRelay();
  return sdkGetQuote({
    chainId: input.fromChainId,
    currency: input.fromCurrency,
    toChainId: input.toChainId,
    toCurrency: input.toCurrency,
    amount: input.amount,
    tradeType: "EXACT_INPUT",
    recipient: input.recipient,
    wallet: input.wallet,
    txs: input.txs,
    options: input.refundOnOrigin != null ? { refundOnOrigin: input.refundOnOrigin } : undefined,
  });
}

/** Executes a previously fetched Relay quote, reporting progress to the caller. */
export async function executeRelay(
  quote: Execute,
  wallet: WalletClient,
  onProgress?: (data: ProgressData) => void,
): Promise<Execute> {
  ensureRelay();
  return sdkExecute({ quote, wallet, onProgress });
}

/** Output amount (base units) a Relay quote will deliver, if present. */
export function relayOutputAmount(quote: Execute): bigint | undefined {
  const raw = quote.details?.currencyOut?.amount;
  return raw != null ? BigInt(raw) : undefined;
}

/** Minimum guaranteed output (base units) of a Relay quote, if present. */
export function relayMinimumOutput(quote: Execute): bigint | undefined {
  const raw = quote.details?.currencyOut?.minimumAmount;
  return raw != null ? BigInt(raw) : undefined;
}

/** USD values of the input/output currencies from a Relay quote, if present. */
export function relayUsd(quote: Execute): { inUsd?: number; outUsd?: number } {
  const i = quote.details?.currencyIn?.amountUsd;
  const o = quote.details?.currencyOut?.amountUsd;
  return {
    inUsd: i != null ? Number(i) : undefined,
    outUsd: o != null ? Number(o) : undefined,
  };
}

/** True once every step of an executed quote is complete. */
export function relayIsComplete(data: ProgressData | Execute): boolean {
  const steps = data.steps ?? [];
  if (steps.length === 0) return false;
  return steps.every((s) => (s.items ?? []).every((i) => i.status === "complete"));
}
