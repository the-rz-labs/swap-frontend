import {
  createClient,
  getClient,
  MAINNET_RELAY_API,
  convertViemChainToRelayChain,
  getQuote as sdkGetQuote,
  execute as sdkExecute,
} from "@reservoir0x/relay-sdk";
import { bsc, mainnet, arbitrum, base, optimism, polygon } from "viem/chains";
import { type WalletClient } from "viem";
import type { Execute, ProgressData, AdaptedWallet, RelayChain } from "@reservoir0x/relay-sdk";

/** A signer Relay can execute with: an EVM viem wallet, or an adapted (e.g. Tron) wallet. */
export type RelayWallet = WalletClient | AdaptedWallet;

let initialized = false;

/**
 * Tron isn't a viem chain, so it must be registered manually. The SDK only needs `id` + `vmType` to
 * resolve a valid Tron dead address for read-only quotes; without it the SDK falls back to the EVM zero
 * address and Relay rejects "Invalid address 0x000…0 for chain 728126428".
 */
const TRON_RELAY_CHAIN: RelayChain = {
  id: 728126428,
  name: "tron",
  displayName: "Tron",
  vmType: "tvm",
  currency: { symbol: "TRX", name: "TRX", address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", decimals: 6 },
  depositEnabled: true,
  tokenSupport: "Limited",
};

/** Lazily configure the Relay client once (idempotent). */
export function ensureRelay() {
  if (initialized) return getClient();
  createClient({
    baseApiUrl: MAINNET_RELAY_API,
    source: process.env.NEXT_PUBLIC_RELAY_SOURCE ?? "rzswap.app",
    chains: [
      ...[bsc, mainnet, arbitrum, base, optimism, polygon].map(convertViemChainToRelayChain),
      TRON_RELAY_CHAIN,
    ],
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
  /** Source/payer address. Needed for read-only estimates on chains the SDK can't derive a dead
   *  address for (e.g. Tron); at execution the wallet supplies it. */
  user?: string;
  wallet?: RelayWallet;
  /** Destination-chain calls to run as part of the fill (bridge-and-execute). */
  txs?: RelayCallTx[];
  /** Refund on the origin chain if the destination execution can't complete. */
  refundOnOrigin?: boolean;
};

/** Fetches a Relay EXACT_INPUT quote. Wallet is optional for read-only estimates. */
export async function getRelayQuote(input: RelayQuoteInput): Promise<Execute> {
  ensureRelay();
  // relay-sdk 2.x no longer auto-fills `user`/`recipient`; passing `includeDefaultParameters = true`
  // (2nd arg) makes it derive them from the wallet (or the chain's dead address for read-only
  // estimates), restoring the 1.x behaviour. Without it the SDK throws "User is required".
  return sdkGetQuote(
    {
      chainId: input.fromChainId,
      currency: input.fromCurrency,
      toChainId: input.toChainId,
      toCurrency: input.toCurrency,
      amount: input.amount,
      tradeType: "EXACT_INPUT",
      recipient: input.recipient,
      user: input.user,
      wallet: input.wallet,
      txs: input.txs,
      options: input.refundOnOrigin != null ? { refundOnOrigin: input.refundOnOrigin } : undefined,
    },
    true,
  );
}

/** Executes a previously fetched Relay quote, reporting progress to the caller. */
export async function executeRelay(
  quote: Execute,
  wallet: RelayWallet,
  onProgress?: (data: ProgressData) => void,
): Promise<Execute> {
  ensureRelay();
  // relay-sdk 2.x returns { data, abortController }; the rest of the app expects the Execute itself.
  const { data } = await sdkExecute({ quote, wallet, onProgress });
  return data;
}

/** Output amount (base units) a Relay quote will deliver, if present. */
export function relayOutputAmount(quote: Execute): bigint | undefined {
  const raw = quote.details?.currencyOut?.amount;
  return raw != null ? BigInt(raw) : undefined;
}

/**
 * Minimum guaranteed output (base units) of a Relay quote, if present.
 * Prefers the lowest of `currencyOut.minimumAmount` and
 * `route.destination.(input|output)Currency.minimumAmount` — Relay sometimes mirrors
 * `minimumAmount === amount` on currencyOut while the real floor lives on the route.
 */
export function relayMinimumOutput(quote: Execute): bigint | undefined {
  const candidates: bigint[] = [];
  const top = quote.details?.currencyOut?.minimumAmount;
  if (top != null && top !== "") candidates.push(BigInt(top));

  const dest = (
    quote.details as {
      route?: {
        destination?: {
          inputCurrency?: { minimumAmount?: string };
          outputCurrency?: { minimumAmount?: string };
        };
      };
    } | undefined
  )?.route?.destination;
  for (const raw of [dest?.inputCurrency?.minimumAmount, dest?.outputCurrency?.minimumAmount]) {
    if (raw != null && raw !== "") candidates.push(BigInt(raw));
  }

  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (a < b ? a : b));
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

function feeUsdField(fee: { amountUsd?: string } | undefined): number | undefined {
  if (fee?.amountUsd == null || fee.amountUsd === "") return undefined;
  const n = Number(fee.amountUsd);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Bridge fee in USD from a Relay quote.
 * Prefers Relay's explicit `fees.relayer` (relayerGas + relayerService rolled up), then
 * `details.totalImpact.usd`, then currencyIn−currencyOut as a last resort.
 * Does NOT include origin wallet `fees.gas` (BNB/ETH the user pays to submit the deposit).
 */
export function relayFeeUsd(quote: Execute): number | undefined {
  const relayer = feeUsdField(quote.fees?.relayer);
  if (relayer != null && relayer >= 0) return relayer;

  const gas = feeUsdField(quote.fees?.relayerGas);
  const service = feeUsdField(quote.fees?.relayerService);
  if (gas != null || service != null) return Math.max(0, (gas ?? 0) + (service ?? 0));

  const impact = quote.details?.totalImpact?.usd;
  if (impact != null && impact !== "") {
    const n = Math.abs(Number(impact));
    if (Number.isFinite(n)) return n;
  }

  const { inUsd, outUsd } = relayUsd(quote);
  if (inUsd == null || outUsd == null) return undefined;
  return Math.max(0, inUsd - outUsd);
}

/** True once every step of an executed quote is complete. */
export function relayIsComplete(data: ProgressData | Execute): boolean {
  const steps = data.steps ?? [];
  if (steps.length === 0) return false;
  return steps.every((s) => (s.items ?? []).every((i) => i.status === "complete"));
}
