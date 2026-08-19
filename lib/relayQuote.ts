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
import { ERC20_ABI } from "./rzswap";


export type QuoteProvider = "relay" | "sushi";

export type QuoteResult = {
  /** Expected final output in destination-token base units (UI "You receive"). */
  output: bigint;
  /** Guaranteed floor: Relay minimum when present, else output × (1 − slippage). */
  minOutput: bigint;
  inputUsd?: number;
  outputUsd?: number;
  bridgeFeeUsd?: number;
  /** Which venue won (local races Relay vs Sushi; cross-chain is always Relay). */
  provider: QuoteProvider;
  /** Short route label for the UI. */
  routeLabel: string;
};

function quoteRecipient(to: Token, recipient: string | undefined): string | undefined {
  if (!isTronToken(to)) return recipient;
  return recipient && isTronAddress(recipient) ? recipient : USDT_TRON_ADDRESS;
}

/** Same-chain EVM pairs can race Sushi; everything else is Relay-only. */
export function canUseSushi(from: Token, to: Token): boolean {
  if (isTronToken(from) || isTronToken(to)) return false;
  if (from.chainId !== to.chainId) return false;
  // Sushi swap API covers major EVMs we list (BSC + ETH today).
  return from.chainId === 56 || from.chainId === 1;
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
    // Same-chain has no bridge — don't surface Relay's in−out gap as a "bridge fee".
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

/**
 * Cross-chain / Tron: Relay only.
 * Same-chain EVM: race Relay vs Sushi and keep the higher expected output.
 * If one side fails, use the other; if both fail, throw.
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

  if (!canUseSushi(from, to)) {
    return quoteRelay(from, to, amountIn, recipient, slippageBps);
  }

  const [relaySettled, sushiSettled] = await Promise.allSettled([
    quoteRelay(from, to, amountIn, recipient, slippageBps),
    quoteSushi(from, to, amountIn, slippageBps),
  ]);

  const relay = relaySettled.status === "fulfilled" ? relaySettled.value : null;
  const sushi =
    sushiSettled.status === "fulfilled" && sushiSettled.value != null ? sushiSettled.value : null;

  if (relay && sushi) {
    return sushi.output > relay.output ? sushi : relay;
  }
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

/** Ensure the Sushi router is approved for `amount` of `token` (skip native). */
export async function ensureSushiAllowance(
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
