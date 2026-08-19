/**
 * Sushi aggregator (Route Processor) REST helpers for same-chain EVM quotes + swap calldata.
 * Docs: https://docs.sushi.com/api/examples/swap
 */

import { getAddress, type Address, type Hex } from "viem";
import { NATIVE_ADDRESS } from "./tokens";

const SUSHI_API = "https://api.sushi.com";
/** Sushi's native-token sentinel (not the zero address). */
export const SUSHI_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

const REFERRER = process.env.NEXT_PUBLIC_SUSHI_REFERRER ?? "rzswap.app";

export type SushiQuote = {
  status: "Success" | "Partial" | "NoWay";
  assumedAmountOut?: string;
  amountIn?: string;
  priceImpact?: number;
  swapPrice?: number;
};

export type SushiSwapTx = {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  gasPrice?: number;
};

export type SushiSwapResponse = SushiQuote & {
  tx?: {
    from: string;
    to: string;
    data: string;
    value?: string;
    gasPrice?: number;
    gas?: string;
  };
};

/** Map our token address to Sushi's native sentinel when needed. */
export function toSushiTokenAddress(address: string): string {
  const a = address.toLowerCase();
  if (a === NATIVE_ADDRESS.toLowerCase() || a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    return SUSHI_NATIVE;
  }
  return getAddress(address as Address);
}

function slippageToDecimal(slippageBps: number): string {
  return (slippageBps / 10_000).toString();
}

async function sushiGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${SUSHI_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("referrer", REFERRER);

  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sushi API ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Same-chain quote (no calldata). Returns null when Sushi has no route or the request fails.
 */
export async function getSushiQuote(input: {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  slippageBps: number;
}): Promise<{ amountOut: bigint; priceImpact?: number } | null> {
  try {
    const q = await sushiGet<SushiQuote>(`/quote/v7/${input.chainId}`, {
      tokenIn: toSushiTokenAddress(input.tokenIn),
      tokenOut: toSushiTokenAddress(input.tokenOut),
      amount: input.amount.toString(),
      maxSlippage: slippageToDecimal(input.slippageBps),
    });
    if (q.status === "NoWay" || q.assumedAmountOut == null) return null;
    const amountOut = BigInt(q.assumedAmountOut);
    if (amountOut <= 0n) return null;
    return { amountOut, priceImpact: q.priceImpact };
  } catch {
    return null;
  }
}

/**
 * Build executable swap calldata for the Route Processor. Throws if no route.
 */
export async function getSushiSwap(input: {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  slippageBps: number;
  sender: Address;
}): Promise<{ amountOut: bigint; tx: SushiSwapTx }> {
  const q = await sushiGet<SushiSwapResponse>(`/swap/v7/${input.chainId}`, {
    tokenIn: toSushiTokenAddress(input.tokenIn),
    tokenOut: toSushiTokenAddress(input.tokenOut),
    amount: input.amount.toString(),
    maxSlippage: slippageToDecimal(input.slippageBps),
    sender: input.sender,
  });
  if (q.status === "NoWay" || !q.tx?.to || !q.tx.data || q.assumedAmountOut == null) {
    throw new Error("Sushi returned no executable swap route.");
  }
  const amountOut = BigInt(q.assumedAmountOut);
  if (amountOut <= 0n) throw new Error("Sushi returned zero output.");

  return {
    amountOut,
    tx: {
      from: getAddress(q.tx.from as Address),
      to: getAddress(q.tx.to as Address),
      data: q.tx.data as Hex,
      value: q.tx.value != null && q.tx.value !== "" ? BigInt(q.tx.value) : undefined,
      gasPrice: q.tx.gasPrice,
    },
  };
}
