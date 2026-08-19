import { getAddress, maxUint256, type Address, type WalletClient } from "viem";
import { readContract, writeContract, waitForTransactionReceipt } from "@wagmi/core";
import { wagmiConfig, type AppChainId } from "./wagmi";
import {
  USDT_TRON_ADDRESS,
  isTronToken,
  NATIVE_ADDRESS,
  type Token,
} from "./tokens";
import { isTronAddress } from "./tron/tronAddress";
import {
  getRelayQuote,
  relayOutputAmount,
  relayMinimumOutput,
  relayUsd,
  relayFeeUsd,
} from "./relay";
import { classify, applySlippage } from "./swapPlan";
import { getSushiQuote } from "./sushi";
import { getLifiQuote } from "./lifi";
import { ERC20_ABI } from "./rzswap";

export type QuoteProvider = "relay" | "sushi" | "lifi";

export type QuoteResult = {
  /** Expected final output in destination-token base units (UI "You receive"). */
  output: bigint;
  /** Guaranteed floor: venue minimum when present, else output × (1 − slippage). */
  minOutput: bigint;
  inputUsd?: number;
  outputUsd?: number;
  bridgeFeeUsd?: number;
  /** Winning venue. */
  provider: QuoteProvider;
  /** Short route label for the UI. */
  routeLabel: string;
};

/** Placeholder EVM address for read-only LI.FI quotes when the wallet isn't connected. */
const LIFI_QUOTE_USER = "0x1111111111111111111111111111111111111111" as Address;

function quoteRecipient(to: Token, recipient: string | undefined): string | undefined {
  if (!isTronToken(to)) return recipient;
  return recipient && isTronAddress(recipient) ? recipient : USDT_TRON_ADDRESS;
}

/** Same-chain EVM pairs can race Sushi. */
export function canUseSushi(from: Token, to: Token): boolean {
  if (isTronToken(from) || isTronToken(to)) return false;
  if (from.chainId !== to.chainId) return false;
  return from.chainId === 56 || from.chainId === 1;
}

/** Cross-chain EVM pairs can race LI.FI (Tron stays Relay-only). */
export function canUseLifi(from: Token, to: Token): boolean {
  if (isTronToken(from) || isTronToken(to)) return false;
  if (from.chainId === to.chainId) return false;
  const supported = new Set([1, 56]);
  return supported.has(from.chainId) && supported.has(to.chainId);
}

function pickBest(a: QuoteResult, b: QuoteResult): QuoteResult {
  return b.output > a.output ? b : a;
}

async function quoteRelay(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
  slippageBps: number,
): Promise<QuoteResult> {
  const quote = await getRelayQuote({
    fromChainId: from.chainId,
    fromCurrency: from.address,
    toChainId: to.chainId,
    toCurrency: to.address,
    amount: amountIn.toString(),
    recipient: quoteRecipient(to, recipient),
    user: isTronToken(from) ? USDT_TRON_ADDRESS : undefined,
  });

  const output = relayOutputAmount(quote);
  if (output == null) throw new Error("Relay returned no output amount.");

  const minOutput = relayMinimumOutput(quote) ?? applySlippage(output, slippageBps);
  const { inUsd, outUsd } = relayUsd(quote);

  return {
    output,
    minOutput,
    inputUsd: inUsd,
    outputUsd: outUsd,
    bridgeFeeUsd: from.chainId !== to.chainId ? relayFeeUsd(quote) : undefined,
    provider: "relay",
    routeLabel: `${from.symbol} → ${to.symbol} via Relay`,
  };
}

async function quoteSushi(
  from: Token,
  to: Token,
  amountIn: bigint,
  slippageBps: number,
): Promise<QuoteResult | null> {
  const q = await getSushiQuote({
    chainId: from.chainId,
    tokenIn: from.address,
    tokenOut: to.address,
    amount: amountIn,
    slippageBps,
  });
  if (!q) return null;
  return {
    output: q.amountOut,
    minOutput: applySlippage(q.amountOut, slippageBps),
    provider: "sushi",
    routeLabel: `${from.symbol} → ${to.symbol} via Sushi`,
  };
}

async function quoteLifi(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
  slippageBps: number,
): Promise<QuoteResult | null> {
  const toAddress =
    recipient && /^0x[a-fA-F0-9]{40}$/.test(recipient) ? (recipient as Address) : LIFI_QUOTE_USER;

  const q = await getLifiQuote({
    fromChainId: from.chainId,
    toChainId: to.chainId,
    fromToken: from.address,
    toToken: to.address,
    amount: amountIn,
    slippageBps,
    fromAddress: LIFI_QUOTE_USER,
    toAddress,
  });
  if (!q) return null;
  return {
    output: q.amountOut,
    minOutput: q.amountOutMin > 0n ? q.amountOutMin : applySlippage(q.amountOut, slippageBps),
    bridgeFeeUsd: q.bridgeFeeUsd,
    provider: "lifi",
    routeLabel: `${from.symbol} → ${to.symbol} via LI.FI${q.tool ? ` (${q.tool})` : ""}`,
  };
}

function settledValue<T>(r: PromiseSettledResult<T | null>): T | null {
  if (r.status !== "fulfilled") return null;
  return r.value;
}

/**
 * Same-chain EVM: race Relay vs Sushi.
 * Cross-chain EVM: race Relay vs LI.FI.
 * Tron / unsupported: Relay only.
 */
export async function computeBestQuote(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
  slippageBps: number,
): Promise<QuoteResult> {
  if (classify(from, to) === "invalid") {
    throw new Error("Unsupported pair.");
  }

  if (canUseSushi(from, to)) {
    const [relaySettled, sushiSettled] = await Promise.allSettled([
      quoteRelay(from, to, amountIn, recipient, slippageBps),
      quoteSushi(from, to, amountIn, slippageBps),
    ]);
    const relay = settledValue(relaySettled);
    const sushi = settledValue(sushiSettled);
    if (relay && sushi) return pickBest(relay, sushi);
    if (relay) return relay;
    if (sushi) return sushi;
    const relayErr =
      relaySettled.status === "rejected"
        ? relaySettled.reason instanceof Error
          ? relaySettled.reason.message
          : String(relaySettled.reason)
        : "no Relay quote";
    throw new Error(`No route available (Relay: ${relayErr}; Sushi: no route).`);
  }

  if (canUseLifi(from, to)) {
    const [relaySettled, lifiSettled] = await Promise.allSettled([
      quoteRelay(from, to, amountIn, recipient, slippageBps),
      quoteLifi(from, to, amountIn, recipient, slippageBps),
    ]);
    const relay = settledValue(relaySettled);
    const lifi = settledValue(lifiSettled);
    if (relay && lifi) return pickBest(relay, lifi);
    if (relay) return relay;
    if (lifi) return lifi;
    const relayErr =
      relaySettled.status === "rejected"
        ? relaySettled.reason instanceof Error
          ? relaySettled.reason.message
          : String(relaySettled.reason)
        : "no Relay quote";
    throw new Error(`No route available (Relay: ${relayErr}; LI.FI: no route).`);
  }

  return quoteRelay(from, to, amountIn, recipient, slippageBps);
}

/** @deprecated Use {@link computeBestQuote}. */
export async function computeRelayOnlyQuote(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
  slippageBps: number,
): Promise<QuoteResult> {
  return computeBestQuote(from, to, amountIn, recipient, slippageBps);
}

/** Ensure a spender is approved for `amount` of `token` (skip native). */
export async function ensureErc20Allowance(
  wallet: WalletClient,
  token: Token,
  spender: Address,
  amount: bigint,
): Promise<void> {
  if (token.address.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) return;
  const account = wallet.account;
  if (!account) throw new Error("Wallet has no account.");
  const tokenAddr = getAddress(token.address as Address);
  const owner = account.address;
  const chainId = token.chainId as AppChainId;

  const allowance = await readContract(wagmiConfig, {
    address: tokenAddr,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
    chainId,
  });

  if (allowance >= amount) return;

  const hash = await writeContract(wagmiConfig, {
    address: tokenAddr,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, maxUint256],
    chainId,
    account,
  });
  await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
}

/** @deprecated Use {@link ensureErc20Allowance}. */
export const ensureSushiAllowance = ensureErc20Allowance;
