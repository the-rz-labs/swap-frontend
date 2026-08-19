/**
 * KyberSwap Aggregator API (v1) — same-chain EVM quotes + encoded swap calldata.
 * Docs: https://docs.kyberswap.com/developer-guide/aggregator-api
 */

import { getAddress, type Address, type Hex } from "viem";
import { NATIVE_ADDRESS } from "./tokens";

const KYBER_API = "https://aggregator-api.kyberswap.com";
const CLIENT_ID = process.env.NEXT_PUBLIC_KYBER_CLIENT_ID ?? "rzswap.app";

/** Kyber native-token sentinel. */
export const KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

const CHAIN_SLUG: Record<number, string> = {
  1: "ethereum",
  56: "bsc",
};

export function kyberChainSlug(chainId: number): string | undefined {
  return CHAIN_SLUG[chainId];
}

export function toKyberTokenAddress(address: string): string {
  const a = address.toLowerCase();
  if (a === NATIVE_ADDRESS.toLowerCase() || a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    return KYBER_NATIVE;
  }
  return getAddress(address as Address);
}

type KyberRouteSummary = Record<string, unknown> & {
  amountIn?: string;
  amountOut?: string;
};

type KyberRoutesResponse = {
  code?: number;
  message?: string;
  data?: {
    routeSummary?: KyberRouteSummary;
    routerAddress?: string;
  };
};

type KyberBuildResponse = {
  code?: number;
  message?: string;
  data?: {
    amountIn?: string;
    amountOut?: string;
    data?: string;
    routerAddress?: string;
    transactionValue?: string;
  };
};

function kyberHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
    "x-client-id": CLIENT_ID,
    // route/build rejects some clients without browser-like Origin.
    Origin: "https://kyberswap.com",
    Referer: "https://kyberswap.com/",
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/**
 * Quote only (GET /api/v1/routes). Returns null when no route.
 * Also returns `routeSummary` for a later `/route/build` call.
 */
export async function getKyberQuote(input: {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
}): Promise<{ amountOut: bigint; routeSummary: KyberRouteSummary; routerAddress: Address } | null> {
  const slug = kyberChainSlug(input.chainId);
  if (!slug) return null;

  try {
    const url = new URL(`${KYBER_API}/${slug}/api/v1/routes`);
    url.searchParams.set("tokenIn", toKyberTokenAddress(input.tokenIn));
    url.searchParams.set("tokenOut", toKyberTokenAddress(input.tokenOut));
    url.searchParams.set("amountIn", input.amount.toString());
    url.searchParams.set("gasInclude", "true");

    const res = await fetch(url.toString(), { headers: kyberHeaders() });
    if (!res.ok) return null;
    const j = (await res.json()) as KyberRoutesResponse;
    if (j.code !== 0 || !j.data?.routeSummary?.amountOut) return null;

    const amountOut = BigInt(j.data.routeSummary.amountOut);
    if (amountOut <= 0n) return null;
    const router = j.data.routerAddress ?? "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";

    return {
      amountOut,
      routeSummary: j.data.routeSummary,
      routerAddress: getAddress(router as Address),
    };
  } catch {
    return null;
  }
}

/**
 * Encode swap calldata (POST /api/v1/route/build). Re-fetches the route then builds.
 * `slippageTolerance` is in bps (50 = 0.5%).
 */
export async function getKyberSwap(input: {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  slippageBps: number;
  sender: Address;
  recipient?: Address;
}): Promise<{ amountOut: bigint; tx: { to: Address; data: Hex; value?: bigint } }> {
  const slug = kyberChainSlug(input.chainId);
  if (!slug) throw new Error("KyberSwap does not support this chain.");

  const quoted = await getKyberQuote({
    chainId: input.chainId,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    amount: input.amount,
  });
  if (!quoted) throw new Error("KyberSwap returned no route.");

  const res = await fetch(`${KYBER_API}/${slug}/api/v1/route/build`, {
    method: "POST",
    headers: kyberHeaders(true),
    body: JSON.stringify({
      routeSummary: quoted.routeSummary,
      sender: input.sender,
      recipient: input.recipient ?? input.sender,
      slippageTolerance: input.slippageBps,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`KyberSwap build ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const j = (await res.json()) as KyberBuildResponse;
  if (j.code !== 0 || !j.data?.data || !j.data.routerAddress) {
    throw new Error(j.message ?? "KyberSwap build failed.");
  }

  const amountOut = BigInt(j.data.amountOut ?? quoted.amountOut.toString());
  const valueRaw = j.data.transactionValue;
  return {
    amountOut,
    tx: {
      to: getAddress(j.data.routerAddress as Address),
      data: j.data.data as Hex,
      value: valueRaw != null && valueRaw !== "" && valueRaw !== "0" ? BigInt(valueRaw) : undefined,
    },
  };
}
