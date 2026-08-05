import {
  createClient,
  getClient,
  MAINNET_RELAY_API,
  convertViemChainToRelayChain,
  getQuote as sdkGetQuote,
  execute as sdkExecute,
} from "@reservoir0x/relay-sdk";
import { bsc, mainnet, arbitrum, base, optimism, polygon } from "viem/chains";
import { decodeFunctionData, encodeFunctionData, type WalletClient, type Hex } from "viem";
import type { Execute, ProgressData, AdaptedWallet, RelayChain } from "@reservoir0x/relay-sdk";

/** A signer Relay can execute with: an EVM viem wallet, or an adapted (e.g. Tron) wallet. */
export type RelayWallet = WalletClient | AdaptedWallet;

// RelayDepository deposit overloads. Relay's /quote returns the FIXED-amount form; we rewrite it to
// the amount-less form so the adapter deposits its FULL balance (the entire swap output) — bridging
// everything instead of a pre-quoted minimum and refunding the slippage drift to the user.
const DEPOSIT_ERC20_FIXED = [
  {
    type: "function",
    name: "depositErc20",
    stateMutability: "nonpayable",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "id", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;
const DEPOSIT_ERC20_FULL = [
  {
    type: "function",
    name: "depositErc20",
    stateMutability: "nonpayable",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "token", type: "address" },
      { name: "id", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/**
 * Rewrite Relay's fixed-amount depositErc20(depositor, token, amount, id) into the amount-less
 * depositErc20(depositor, token, id), which deposits the caller's FULL approval. The adapter approves
 * the depository for the entire swap output, so this forwards 100% of the output to Relay with no
 * drift refund. The `id` is the order id (does not encode the amount). If Relay ever returns a
 * different deposit shape, we leave the calldata untouched (safe fallback to the quoted behavior).
 */
function toFullBalanceDeposit(calldata: Hex): Hex {
  try {
    const { functionName, args } = decodeFunctionData({ abi: DEPOSIT_ERC20_FIXED, data: calldata });
    if (functionName !== "depositErc20") return calldata;
    const [depositor, token, , id] = args as [string, string, bigint, Hex];
    return encodeFunctionData({
      abi: DEPOSIT_ERC20_FULL,
      functionName: "depositErc20",
      args: [depositor as `0x${string}`, token as `0x${string}`, id],
    });
  } catch {
    return calldata; // not the expected shape — keep Relay's calldata as-is
  }
}

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

/**
 * SELL helper: quotes a USDT-out bridge whose ON-CHAIN depositor is `depositor` (our
 * RelayDepositAdapter), and returns the depository call to execute. The adapter runs this calldata
 * after the RzSwap swap, so the sell is one approve + one call. Uses the raw API (not the SDK) so we
 * can set `user` to a contract.
 *
 * The returned calldata is rewritten to the amount-less depositErc20 so the adapter deposits its FULL
 * balance (the entire swap output) — the whole output is bridged to Relay, with no drift refunded to
 * the user. `amount` is still sent to /quote so Relay can price the destination output; the on-chain
 * deposit amount is the adapter's actual balance, which the Relay allocator credits via the deposit
 * event. (`amount` = the swap's expected output so the destination estimate matches what's bridged.)
 */
export type RelaySellDeposit = { depository: `0x${string}`; data: `0x${string}`; value: string };

export async function getRelaySellDeposit(input: {
  depositor: string;
  /**
   * Origin-chain address that receives Relay's async refund if the destination fill fails.
   * MUST be the end user — never the adapter. `user` stays the adapter (on-chain depositor);
   * without `refundTo`, refunds land on the adapter and get stuck.
   */
  refundTo: string;
  recipient: string;
  originCurrency: string; // USDT on the origin hub
  amount: string; // base units used for the destination quote (swap's expected output)
  toChainId: number;
  toCurrency: string;
  /** Origin chain of the adapter deposit (default BSC 56; pass 1 for ETH GOLDGR sells). */
  originChainId?: number;
  /** Destination-chain calls (e.g. fulfillBuy on the other hub). */
  txs?: RelayCallTx[];
  /** Prefer origin-chain refund on dest failure (default true). */
  refundOnOrigin?: boolean;
}): Promise<RelaySellDeposit> {
  const body: Record<string, unknown> = {
    user: input.depositor,
    refundTo: input.refundTo,
    recipient: input.recipient,
    originChainId: input.originChainId ?? 56,
    destinationChainId: input.toChainId,
    originCurrency: input.originCurrency,
    destinationCurrency: input.toCurrency,
    amount: input.amount,
    tradeType: "EXACT_INPUT",
    options: { refundOnOrigin: input.refundOnOrigin ?? true },
  };
  if (input.txs?.length) body.txs = input.txs;

  const res = await fetch("https://api.relay.link/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || j?.message) throw new Error(`Relay sell quote failed: ${j?.message ?? res.status}`);
  const dep = (j.steps ?? []).find((s: { id?: string }) => s.id === "deposit");
  const item = dep?.items?.[0]?.data;
  if (!item?.to || !item?.data) throw new Error("Relay returned no deposit step for the sell.");
  return { depository: item.to, data: toFullBalanceDeposit(item.data as Hex), value: item.value ?? "0" };
}

/**
 * Reject dust sells where Relay's fixed fees would dominate — those fills often revert on dest
 * `minOut` and force an origin USDT refund (original token already swapped).
 */
export function assertBridgeSizeOk(quote: Execute, label = "swap"): void {
  const { inUsd, outUsd } = relayUsd(quote);
  const fee = relayFeeUsd(quote);
  if (outUsd != null && outUsd < 2) {
    throw new Error(`Amount too small for a cross-chain ${label} — try at least ~$2 after bridge fees.`);
  }
  if (inUsd != null && fee != null && inUsd > 0 && fee / inUsd > 0.2) {
    throw new Error(
      `Bridge fees are too high for this size (~${Math.round((fee / inUsd) * 100)}% of input). Try a larger amount.`,
    );
  }
}

/** True once every step of an executed quote is complete. */
export function relayIsComplete(data: ProgressData | Execute): boolean {
  const steps = data.steps ?? [];
  if (steps.length === 0) return false;
  return steps.every((s) => (s.items ?? []).every((i) => i.status === "complete"));
}
