/**
 * LI.FI REST helpers for cross-chain quotes + executable calldata (EVM and Tron).
 * Docs: https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer
 */

import { getAddress, type Address, type Hex } from "viem";
import { NATIVE_ADDRESS, TRON_CHAIN_ID } from "./tokens";
import { isTronAddress } from "./tron/tronAddress";

const LIFI_API = "https://li.quest/v1";
const INTEGRATOR = process.env.NEXT_PUBLIC_LIFI_INTEGRATOR ?? "rzswap.app";

/** Optional API key for higher rate limits (portal.li.fi). */
const LIFI_API_KEY = process.env.NEXT_PUBLIC_LIFI_API_KEY;

export type LifiTxRequest = {
  /** EVM `0x…` or Tron base58 `T…`. */
  to: string;
  from?: string;
  data: Hex;
  value?: bigint;
  chainId?: number;
  gasLimit?: string;
};

export type LifiQuoteResult = {
  amountOut: bigint;
  amountOutMin: bigint;
  /** Bridge / gas-receiver style fees (excludes LI.FI's 0.25% platform fee). */
  bridgeFeeUsd?: number;
  /** LI.FI platform service fee (often 0.25% "LIFI Fixed Fee"). */
  serviceFeeUsd?: number;
  tool?: string;
  /** Spender to approve on the source token (EVM or Tron address). */
  approvalAddress?: string;
  /** Present when fromAddress was supplied — ready to send on the source chain. */
  tx?: LifiTxRequest;
};

type LifiFeeCost = {
  amountUSD?: string;
  name?: string;
  included?: boolean;
};

function sumBridgeFeeUsd(fees: LifiFeeCost[] | undefined): number | undefined {
  if (!fees?.length) return undefined;
  let total = 0;
  let any = false;
  for (const f of fees) {
    const name = (f.name ?? "").toLowerCase();
    if (name.includes("lifi fixed") || name.includes("integrator")) continue;
    if (name.includes("gas") && !name.includes("receiver")) continue;
    if (f.amountUSD == null || f.amountUSD === "") continue;
    const n = Number(f.amountUSD);
    if (!Number.isFinite(n) || n < 0) continue;
    total += n;
    any = true;
  }
  return any ? total : undefined;
}

function sumLifiServiceFeeUsd(fees: LifiFeeCost[] | undefined): number | undefined {
  if (!fees?.length) return undefined;
  let total = 0;
  let any = false;
  for (const f of fees) {
    const name = (f.name ?? "").toLowerCase();
    if (!(name.includes("lifi fixed") || name.includes("integrator"))) continue;
    if (f.amountUSD == null || f.amountUSD === "") continue;
    const n = Number(f.amountUSD);
    if (!Number.isFinite(n) || n < 0) continue;
    total += n;
    any = true;
  }
  return any ? total : undefined;
}

type LifiEstimate = {
  toAmount?: string;
  toAmountMin?: string;
  feeCosts?: LifiFeeCost[];
  approvalAddress?: string;
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

/** Pass through Tron base58; checksum EVM; map native sentinels to zero address. */
export function toLifiToken(address: string): string {
  if (isTronAddress(address)) return address;
  const a = address.toLowerCase();
  if (a === NATIVE_ADDRESS.toLowerCase() || a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    return NATIVE_ADDRESS;
  }
  return getAddress(address as Address);
}

function parseTxAddress(addr: string): string {
  if (isTronAddress(addr)) return addr;
  return getAddress(addr as Address);
}

function parseValue(value: string | undefined): bigint | undefined {
  if (value == null || value === "") return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
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
      to: parseTxAddress(tr.to),
      from: tr.from ? parseTxAddress(tr.from) : undefined,
      data: tr.data as Hex,
      value: parseValue(tr.value),
      chainId: tr.chainId,
      gasLimit: tr.gasLimit,
    };
  }

  return {
    amountOut,
    amountOutMin,
    bridgeFeeUsd: sumBridgeFeeUsd(j.estimate?.feeCosts),
    serviceFeeUsd: sumLifiServiceFeeUsd(j.estimate?.feeCosts),
    tool: j.tool,
    approvalAddress: j.estimate?.approvalAddress,
    tx,
  };
}

/**
 * Cross-chain quote (EVM↔EVM or EVM↔Tron). Pass addresses to include calldata.
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
 * Quote + calldata for execution. `fromAddress`/`toAddress` may be EVM or Tron.
 */
export async function getLifiSwap(input: {
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  amount: bigint;
  slippageBps: number;
  fromAddress: string;
  toAddress: string;
}): Promise<{
  amountOut: bigint;
  amountOutMin: bigint;
  tx: LifiTxRequest;
  approvalAddress?: string;
  bridgeFeeUsd?: number;
}> {
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
    approvalAddress: q.approvalAddress,
    bridgeFeeUsd: q.bridgeFeeUsd,
  };
}

export function isLifiTronChain(chainId: number | undefined): boolean {
  return chainId === TRON_CHAIN_ID;
}
