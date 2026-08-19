/**
 * Fly Trade aggregator — same-chain EVM quotes + encoded swap calldata.
 * Docs: https://docs.fly.trade/developers/api-reference/evm-swap-integration-guide
 */

import { getAddress, type Address, type Hex } from "viem";
import { NATIVE_ADDRESS } from "./tokens";

const FLY_API = "https://api.fly.trade";

/** Fly native-token sentinel (zero address). */
export const FLY_NATIVE = "0x0000000000000000000000000000000000000000" as Address;

/** Placeholder wallet for read-only quotes when no address is connected. */
const FLY_QUOTE_USER = "0x1111111111111111111111111111111111111111" as Address;

const NETWORK: Record<number, string> = {
  1: "ethereum",
  56: "bsc",
};

export function flyNetwork(chainId: number): string | undefined {
  return NETWORK[chainId];
}

export function toFlyTokenAddress(address: string): Address {
  const a = address.toLowerCase();
  if (
    a === NATIVE_ADDRESS.toLowerCase() ||
    a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  ) {
    return FLY_NATIVE;
  }
  return getAddress(address as Address);
}

function slippageFraction(slippageBps: number): string {
  return (slippageBps / 10_000).toString();
}

type FlyQuoteBody = {
  id?: string;
  amountOut?: string;
  targetAddress?: string;
  message?: string;
  code?: number;
};

type FlyTxBody = {
  to?: string;
  data?: string;
  value?: string;
  from?: string;
};

type FlyQuoteTransactionResponse = {
  quote?: FlyQuoteBody;
  transaction?: FlyTxBody;
  message?: string;
  code?: number;
};

/**
 * Quote only (GET /aggregator/quote). Returns null when no route.
 */
export async function getFlyQuote(input: {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  slippageBps?: number;
  fromAddress?: Address;
  toAddress?: Address;
}): Promise<{ amountOut: bigint; quoteId?: string } | null> {
  const network = flyNetwork(input.chainId);
  if (!network) return null;

  try {
    const from = input.fromAddress ?? FLY_QUOTE_USER;
    const to = input.toAddress ?? from;
    const url = new URL(`${FLY_API}/aggregator/quote`);
    url.searchParams.set("network", network);
    url.searchParams.set("fromTokenAddress", toFlyTokenAddress(input.tokenIn));
    url.searchParams.set("toTokenAddress", toFlyTokenAddress(input.tokenOut));
    url.searchParams.set("sellAmount", input.amount.toString());
    url.searchParams.set("slippage", slippageFraction(input.slippageBps ?? 50));
    url.searchParams.set("fromAddress", from);
    url.searchParams.set("toAddress", to);
    url.searchParams.set("gasless", "false");

    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const j = (await res.json()) as FlyQuoteBody;
    if (!j.amountOut) return null;
    const amountOut = BigInt(j.amountOut);
    if (amountOut <= 0n) return null;
    return { amountOut, quoteId: j.id };
  } catch {
    return null;
  }
}

/**
 * Encode swap calldata via combined GET /aggregator/quote/transaction
 * (avoids separate /transaction gas-estimate failures).
 */
export async function getFlySwap(input: {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  slippageBps: number;
  sender: Address;
  recipient?: Address;
}): Promise<{ amountOut: bigint; tx: { to: Address; data: Hex; value?: bigint } }> {
  const network = flyNetwork(input.chainId);
  if (!network) throw new Error("Fly does not support this chain.");

  const url = new URL(`${FLY_API}/aggregator/quote/transaction`);
  url.searchParams.set("network", network);
  url.searchParams.set("fromTokenAddress", toFlyTokenAddress(input.tokenIn));
  url.searchParams.set("toTokenAddress", toFlyTokenAddress(input.tokenOut));
  url.searchParams.set("sellAmount", input.amount.toString());
  url.searchParams.set("slippage", slippageFraction(input.slippageBps));
  url.searchParams.set("fromAddress", input.sender);
  url.searchParams.set("toAddress", input.recipient ?? input.sender);
  url.searchParams.set("gasless", "false");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fly swap ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const j = (await res.json()) as FlyQuoteTransactionResponse;
  const amountOutRaw = j.quote?.amountOut;
  const tx = j.transaction;
  if (!amountOutRaw || !tx?.to || !tx.data) {
    throw new Error(j.message ?? "Fly returned no swap transaction.");
  }

  const valueRaw = tx.value;
  return {
    amountOut: BigInt(amountOutRaw),
    tx: {
      to: getAddress(tx.to as Address),
      data: tx.data as Hex,
      value: valueRaw != null && valueRaw !== "" && valueRaw !== "0" ? BigInt(valueRaw) : undefined,
    },
  };
}
