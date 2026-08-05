/**
 * Shared helpers for GOLDGR (and other) routes that compose Relay → treasury fulfillBuy.
 *
 * Model:
 *  - Relay quote MUST include destination fulfillBuy `txs` so fees.relayer / minimumAmount
 *    price dest-call gas. Probe with {@link buildDestFillProbeTxs} (minOut=1), then rebuild
 *    txs with the real floor from {@link quoteRelayThenGoldgr} / {@link quoteRelayThenBscToken}.
 *  - UI "You receive" = treasury quote(Relay expected USDT).
 *  - On-chain fulfillBuy minOut = slip(treasury quote(Relay minimum USDT)) with a small
 *    extra buffer for treasury/oracle drift between the FE quote and the dest fill.
 */
import type { Address, Hex } from "viem";
import type { Execute } from "@reservoir0x/relay-sdk";
import { applySlippage } from "./swapPlan";
import { relayMinimumOutput, relayOutputAmount, relayUsd, relayFeeUsd, type RelayCallTx } from "./relay";
import { resolveEthGoldgrPath, resolveBestBscPath, ethUsdValue, bscUsdValue } from "./route";
import { GOLDGR, USDT_ETH, USDT_BSC, type Token } from "./tokens";
import { buildBuyTxs, buildEthBuyTxs } from "./gateway";

/**
 * Extra bps on the treasury leg after Relay's fee-aware minimum.
 * Bridge fees are already in Relay minimumAmount; this only covers oracle/AMM drift
 * between quoting and the async dest fill (seen: ~0.8–2% move → SlippageExceeded).
 */
export const DEST_PRICE_BUFFER_BPS = 300;

/**
 * Placeholder fulfillBuy minOut for a fee-probe quote. Dest-call gas does not depend on the
 * value; use this to attach `txs` before the real floor is known, then rebuild.
 */
export const DEST_FILL_PLACEHOLDER_MIN_OUT = 1n;

/** Zero swapId for read-only UI quotes (not executed on-chain). */
export const DEST_FILL_QUOTE_SWAP_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

/**
 * BSC dest-fill probe txs (cleanupErc20sViaCall) with placeholder minOut.
 */
export function buildDestFillProbeTxs(
  args: Omit<Parameters<typeof buildBuyTxs>[0], "minOut">,
): RelayCallTx[] {
  return buildBuyTxs({ ...args, minOut: DEST_FILL_PLACEHOLDER_MIN_OUT });
}

/**
 * ETH dest-fill probe txs (cleanupErc20s → EthUsdtFillAdapter) with placeholder minOut.
 */
export function buildEthDestFillProbeTxs(
  args: Omit<Parameters<typeof buildEthBuyTxs>[0], "minOut">,
): RelayCallTx[] {
  return buildEthBuyTxs({ ...args, minOut: DEST_FILL_PLACEHOLDER_MIN_OUT });
}

export type RelayOutAmounts = {
  /** Expected dest hub amount (fees already deducted in Relay's quote). */
  expected: bigint;
  /** Guaranteed dest hub amount — use this to floor fulfillBuy. */
  minimum: bigint;
};

/** Read fee-aware expected + minimum from a Relay quote. */
export function relayOutAmounts(quote: Execute): RelayOutAmounts {
  const expected = relayOutputAmount(quote);
  if (expected == null || expected <= 0n) throw new Error("Relay returned no output amount.");
  const minimum = relayMinimumOutput(quote) ?? expected;
  if (minimum <= 0n) throw new Error("Relay returned no minimum output.");
  return { expected, minimum };
}

/** User slip + dest price buffer, capped at 50%. */
export function destTreasurySlippageBps(userSlippageBps: number): number {
  return Math.min(5_000, userSlippageBps + DEST_PRICE_BUFFER_BPS);
}

export type DestFillQuote = {
  /** Expected final token out (for UI). */
  output: bigint;
  /**
   * Guaranteed final token out after user slippage + dest price buffer on the treasury leg.
   * Built from Relay minimum hub amount (fees already included there).
   */
  minOutput: bigint;
  path: Address[];
  hubExpected: bigint;
  hubMinimum: bigint;
  inputUsd?: number;
  outputUsd?: number;
  bridgeFeeUsd?: number;
};

/**
 * USDT(ETH) → GOLDGR: display from Relay expected hub; minOut from Relay minimum hub + slips.
 */
export async function quoteRelayThenGoldgr(
  bridgeQuote: Execute,
  slippageBps: number,
): Promise<DestFillQuote> {
  const { expected, minimum } = relayOutAmounts(bridgeQuote);
  const [exp, min] = await Promise.all([
    resolveEthGoldgrPath(expected, USDT_ETH, GOLDGR),
    resolveEthGoldgrPath(minimum, USDT_ETH, GOLDGR),
  ]);
  const minOutput = applySlippage(min.amountOut, destTreasurySlippageBps(slippageBps));
  const { inUsd } = relayUsd(bridgeQuote);
  const outputUsd = await ethUsdValue(GOLDGR, exp.amountOut);
  return {
    output: exp.amountOut,
    minOutput,
    path: exp.path,
    hubExpected: expected,
    hubMinimum: minimum,
    inputUsd: inUsd,
    outputUsd: outputUsd ?? relayUsd(bridgeQuote).outUsd,
    bridgeFeeUsd: relayFeeUsd(bridgeQuote),
  };
}

/**
 * USDT(BSC) → BSC token after Relay: same expected/minimum model.
 */
export async function quoteRelayThenBscToken(
  bridgeQuote: Execute,
  tokenOut: Token,
  slippageBps: number,
): Promise<DestFillQuote> {
  const { expected, minimum } = relayOutAmounts(bridgeQuote);
  const [exp, min] = await Promise.all([
    resolveBestBscPath(expected, USDT_BSC.address, tokenOut.address),
    resolveBestBscPath(minimum, USDT_BSC.address, tokenOut.address),
  ]);
  const minOutput = applySlippage(min.amountOut, destTreasurySlippageBps(slippageBps));
  const { inUsd } = relayUsd(bridgeQuote);
  const outputUsd = await bscUsdValue(tokenOut, exp.amountOut);
  return {
    output: exp.amountOut,
    minOutput,
    path: exp.path,
    hubExpected: expected,
    hubMinimum: minimum,
    inputUsd: inUsd,
    outputUsd: outputUsd ?? relayUsd(bridgeQuote).outUsd,
    bridgeFeeUsd: relayFeeUsd(bridgeQuote),
  };
}
