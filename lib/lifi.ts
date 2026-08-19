/**
 * LI.FI REST helpers for cross-chain (and same-chain) quotes + executable calldata.
 * Docs: https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer
 */

import { getAddress, type Address, type Hex } from "viem";
import { NATIVE_ADDRESS } from "./tokens";

const LIFI_API = "https://li.quest/v1";
const INTEGRATOR = process.env.NEXT_PUBLIC_LIFI_INTEGRATOR ?? "rzswap.app";

/** Optional API key for higher rate limits (portal.li.fi). */
const LIFI_API_KEY = process.env.NEXT_PUBLIC_LIFI_API_KEY;

export type LifiTxRequest = {
  to: Address;
  from?: Address;
  data: Hex;
  value?: bigint;
  chainId?: number;
  gasLimit?: string;
};

export type LifiQuoteResult = {
  amountOut: bigint;
  amountOutMin: bigint;
  bridgeFeeUsd?: number;
  tool?: string;
  /** Present when fromAddress was supplied — ready to send on the source chain. */
  tx?: LifiTxRequest;
};

type LifiFeeCost = { amountUSD?: string; name?: string };
type LifiEstimate = {
  toAmount?: string;
  toAmountMin?: string;
  feeCosts?: LifiFeeCost[];
};
type LifiQuoteResponse = {
  estimate?: LifiEstimate;
  transactionRequest?: {
    to?: string;
    from?: string;
    data?: string;
    value?: string;
    chainId?: number;
    gasLimit?: string;
  };
  tool?: string;
  message?: string;
  code?: string | number;
};

function toLifiToken(address: string): string {
  const a = address.toLowerCase();
  if (a === NATIVE_ADDRESS.toLowerCase() || a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    return NATIVE_ADDRESS;
  }
  return getAddress(address as Address);
}

function sumFeeUsd(fees: LifiFeeCost[] | undefined): number | undefined {
  if (!fees?.length) return undefined;
  let total = 0;
  let any = false;
  for (const f of fees) {
    if (f.amountUSD == null || f.amountUSD === "") continue;
    const n = Number(f.amountUSD);
    if (!Number.isFinite(n)) continue;
    total += n;
    any = true;
  }
  return any ? total : undefined;
}

async function lifiGet(path: string, params: Record<string, string>): Promise<LifiQuoteResponse> {
  const url = new URL(`${LIFI_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("integrator", INTEGRATOR);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (LIFI_API_KEY) headers["x-lifi-api-key"] = LIFI_API_KEY;

  const res = await fetch(url.toString(), { headers });
  const json = (await res.json()) as LifiQuoteResponse;
  if (!res.ok) {
    throw new Error(json.message ?? `LI.FI HTTP ${res.status}`);
  }
  return json;
}

function parseQuote(j: LifiQuoteResponse): LifiQuoteResult | null {
  const toAmount = j.estimate?.toAmount;
  if (toAmount == null) return null;
  const amountOut = BigInt(toAmount);
  if (amountOut <= 0n) return null;
  const minRaw = j.estimate?.toAmountMin;
  const amountOutMin = minRaw != null ? BigInt(minRaw) : amountOut;

  let tx: LifiTxRequest | undefined;
  const tr = j.transactionRequest;
  if (tr?.to && tr.data) {
    tx = {
      to: getAddress(tr.to as Address),
      from: tr.from ? getAddress(tr.from as Address) : undefined,
      data: tr.data as Hex,
      value: tr.value != null && tr.value !== "" ? BigInt(tr.value) : undefined,
      chainId: tr.chainId,
      gasLimit: tr.gasLimit,
    };
  }

  return {
    amountOut,
    amountOutMin,
    bridgeFeeUsd: sumFeeUsd(j.estimate?.feeCosts),
    tool: j.tool,
    tx,
  };
}

/**
 * Cross-chain (or any) quote. Pass `fromAddress`/`toAddress` to include executable calldata.
 * Returns null when LI.FI has no route.
 */
export async function getLifiQuote(input: {
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  amount: bigint;
  slippageBps: number;
  fromAddress?: string;
  toAddress?: string;
}): Promise<LifiQuoteResult | null> {
  try {
    const params: Record<string, string> = {
      fromChain: String(input.fromChainId),
      toChain: String(input.toChainId),
      fromToken: toLifiToken(input.fromToken),
      toToken: toLifiToken(input.toToken),
      fromAmount: input.amount.toString(),
      slippage: (input.slippageBps / 10_000).toString(),
    };
    if (input.fromAddress) params.fromAddress = input.fromAddress;
    if (input.toAddress) params.toAddress = input.toAddress;

    const j = await lifiGet("/quote", params);
    return parseQuote(j);
  } catch {
    return null;
  }
}

/**
 * Quote + calldata for execution. Requires a real EVM `fromAddress`.
 */
export async function getLifiSwap(input: {
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  amount: bigint;
  slippageBps: number;
  fromAddress: Address;
  toAddress: Address;
}): Promise<{ amountOut: bigint; amountOutMin: bigint; tx: LifiTxRequest; bridgeFeeUsd?: number }> {
  const q = await getLifiQuote({
    ...input,
    fromAddress: input.fromAddress,
    toAddress: input.toAddress,
  });
  if (!q?.tx) throw new Error("LI.FI returned no executable route.");
  return {
    amountOut: q.amountOut,
    amountOutMin: q.amountOutMin,
    tx: q.tx,
    bridgeFeeUsd: q.bridgeFeeUsd,
  };
}
