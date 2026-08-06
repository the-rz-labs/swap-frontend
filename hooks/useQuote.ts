"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import {
  BSC_CHAIN_ID,
  ETH_CHAIN_ID,
  USDT_BSC,
  USDT_ETH,
  GOLDGR,
  USDT_TRON_ADDRESS,
  isTronToken,
  isBscToken,
  tokenKey,
  type Token,
} from "@/lib/tokens";
import { isTronAddress } from "@/lib/tron/tronAddress";
import { resolveBestBscPath, resolveBestBscUsdtPath, resolveEthGoldgrPath, bscUsdValue, ethUsdValue } from "@/lib/route";
import { getRelayQuote, relayOutputAmount, relayMinimumOutput, relayUsd, relayFeeUsd } from "@/lib/relay";
import {
  quoteRelayThenGoldgr,
  quoteRelayThenBscToken,
  buildDestFillProbeTxs,
  buildEthDestFillProbeTxs,
  DEST_FILL_QUOTE_SWAP_ID,
} from "@/lib/relayDestFill";
import { classify, applySlippage } from "@/lib/swapPlan";
import { ETH_USDT_FILL_ADAPTER, ethBuyFillConfigured, ethGoldgrPath } from "@/lib/hub";

/** Non-zero stand-in when quoting without a connected wallet (fulfillBuy rejects address(0)). */
const QUOTE_USER_FALLBACK = "0x1111111111111111111111111111111111111111" as Address;

function quoteUser(recipient: string | undefined): Address {
  if (recipient && /^0x[a-fA-F0-9]{40}$/.test(recipient)) return recipient as Address;
  return QUOTE_USER_FALLBACK;
}

export type QuoteResult = {
  /** Expected final output in destination-token base units (UI "You receive"). */
  output: bigint;
  /**
   * Guaranteed floor after fees + user slippage.
   * For Relay→treasury routes: treasury(quote(Relay minimum)) × (1 − slip).
   * Otherwise: applySlippage(output, slip).
   */
  minOutput: bigint;
  /** Hub USDT amount (expected) when the route passes through a hub. */
  hubAmount?: bigint;
  /** Relay guaranteed hub USDT (before treasury swap), when applicable. */
  hubMinimum?: bigint;
  inputUsd?: number;
  outputUsd?: number;
  bridgeFeeUsd?: number;
};

async function computeGoldgrQuote(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
  slippageBps: number,
): Promise<QuoteResult> {
  const kind = classify(from, to);
  const user = quoteUser(recipient);

  if (kind === "local-eth") {
    const { amountOut } = await resolveEthGoldgrPath(amountIn, from, to);
    const [inputUsd, outputUsd] = await Promise.all([ethUsdValue(from, amountIn), ethUsdValue(to, amountOut)]);
    return {
      output: amountOut,
      minOutput: applySlippage(amountOut, slippageBps),
      inputUsd,
      outputUsd,
    };
  }

  if (kind === "buy-goldgr") {
    if (!ethBuyFillConfigured()) {
      throw new Error("ETH GOLDGR buy is not configured — set NEXT_PUBLIC_ETH_USDT_FILL_ADAPTER.");
    }
    const path = ethGoldgrPath(USDT_ETH, GOLDGR);
    const probeTxs = buildEthDestFillProbeTxs({
      swapId: DEST_FILL_QUOTE_SWAP_ID,
      tokenOut: GOLDGR.address as Address,
      path,
      user,
      usdt: USDT_ETH.address as Address,
      fillAdapter: ETH_USDT_FILL_ADAPTER,
    });
    const quote = await getRelayQuote({
      fromChainId: from.chainId,
      fromCurrency: from.address,
      toChainId: ETH_CHAIN_ID,
      toCurrency: USDT_ETH.address,
      amount: amountIn.toString(),
      recipient,
      user: isTronToken(from) ? USDT_TRON_ADDRESS : undefined,
      txs: probeTxs,
      refundOnOrigin: true,
    });
    const fill = await quoteRelayThenGoldgr(quote, slippageBps);
    return {
      output: fill.output,
      minOutput: fill.minOutput,
      hubAmount: fill.hubExpected,
      hubMinimum: fill.hubMinimum,
      inputUsd: fill.inputUsd,
      outputUsd: fill.outputUsd,
      bridgeFeeUsd: fill.bridgeFeeUsd,
    };
  }

  if (kind === "bsc-to-goldgr") {
    if (!ethBuyFillConfigured()) {
      throw new Error("ETH GOLDGR buy is not configured — set NEXT_PUBLIC_ETH_USDT_FILL_ADAPTER.");
    }
    const { amountOut: hubBsc } = await resolveBestBscPath(amountIn, from.address, USDT_BSC.address);
    const path = ethGoldgrPath(USDT_ETH, GOLDGR);
    const probeTxs = buildEthDestFillProbeTxs({
      swapId: DEST_FILL_QUOTE_SWAP_ID,
      tokenOut: GOLDGR.address as Address,
      path,
      user,
      usdt: USDT_ETH.address as Address,
      fillAdapter: ETH_USDT_FILL_ADAPTER,
    });
    const quote = await getRelayQuote({
      fromChainId: BSC_CHAIN_ID,
      fromCurrency: USDT_BSC.address,
      toChainId: ETH_CHAIN_ID,
      toCurrency: USDT_ETH.address,
      amount: hubBsc.toString(),
      recipient,
      txs: probeTxs,
      refundOnOrigin: true,
    });
    const fill = await quoteRelayThenGoldgr(quote, slippageBps);
    return {
      output: fill.output,
      minOutput: fill.minOutput,
      hubAmount: fill.hubExpected,
      hubMinimum: fill.hubMinimum,
      inputUsd: fill.inputUsd,
      outputUsd: fill.outputUsd,
      bridgeFeeUsd: fill.bridgeFeeUsd,
    };
  }

  // sell-goldgr
  const { amountOut: hubEth } = await resolveEthGoldgrPath(amountIn, GOLDGR, USDT_ETH);

  if (isBscToken(to) && tokenKey(to) !== tokenKey(USDT_BSC)) {
    const { path } = await resolveBestBscUsdtPath(to.address);
    const probeTxs = buildDestFillProbeTxs({
      swapId: DEST_FILL_QUOTE_SWAP_ID,
      tokenOut: to.address as Address,
      path,
      user,
    });
    const quote = await getRelayQuote({
      fromChainId: ETH_CHAIN_ID,
      fromCurrency: USDT_ETH.address,
      toChainId: BSC_CHAIN_ID,
      toCurrency: USDT_BSC.address,
      amount: hubEth.toString(),
      recipient,
      txs: probeTxs,
      refundOnOrigin: true,
    });
    const fill = await quoteRelayThenBscToken(quote, to, slippageBps);
    return {
      output: fill.output,
      minOutput: fill.minOutput,
      hubAmount: hubEth,
      hubMinimum: fill.hubMinimum,
      inputUsd: fill.inputUsd,
      outputUsd: fill.outputUsd,
      bridgeFeeUsd: fill.bridgeFeeUsd,
    };
  }

  const quoteRecipient = isTronToken(to)
    ? recipient && isTronAddress(recipient)
      ? recipient
      : USDT_TRON_ADDRESS
    : recipient;
  const quote = await getRelayQuote({
    fromChainId: ETH_CHAIN_ID,
    fromCurrency: USDT_ETH.address,
    toChainId: to.chainId,
    toCurrency: to.address,
    amount: hubEth.toString(),
    recipient: quoteRecipient,
  });
  const output = relayOutputAmount(quote);
  if (output == null) throw new Error("Relay returned no output amount.");
  const minimum = relayMinimumOutput(quote) ?? output;
  const { inUsd, outUsd } = relayUsd(quote);
  const inputUsd = (await ethUsdValue(GOLDGR, amountIn)) ?? inUsd;
  return {
    output,
    minOutput: applySlippage(minimum, slippageBps),
    hubAmount: hubEth,
    hubMinimum: minimum,
    inputUsd,
    outputUsd: outUsd,
    bridgeFeeUsd: relayFeeUsd(quote),
  };
}

async function computeQuote(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
  slippageBps: number,
): Promise<QuoteResult> {
  const kind = classify(from, to);

  if (
    kind === "local-eth" ||
    kind === "buy-goldgr" ||
    kind === "sell-goldgr" ||
    kind === "bsc-to-goldgr"
  ) {
    return computeGoldgrQuote(from, to, amountIn, recipient, slippageBps);
  }

  if (kind === "local") {
    const { amountOut } = await resolveBestBscPath(amountIn, from.address, to.address);
    const [inputUsd, outputUsd] = await Promise.all([bscUsdValue(from, amountIn), bscUsdValue(to, amountOut)]);
    return {
      output: amountOut,
      minOutput: applySlippage(amountOut, slippageBps),
      inputUsd,
      outputUsd,
    };
  }

  if (kind === "outbound") {
    const hubIsEndpoint = tokenKey(from) === tokenKey(USDT_BSC);
    const hubAmount = hubIsEndpoint
      ? amountIn
      : (await resolveBestBscPath(amountIn, from.address, USDT_BSC.address)).amountOut;
    const quoteRecipient = isTronToken(to)
      ? recipient && isTronAddress(recipient)
        ? recipient
        : USDT_TRON_ADDRESS
      : recipient;
    const quote = await getRelayQuote({
      fromChainId: BSC_CHAIN_ID,
      fromCurrency: USDT_BSC.address,
      toChainId: to.chainId,
      toCurrency: to.address,
      amount: hubAmount.toString(),
      recipient: quoteRecipient,
    });
    const output = relayOutputAmount(quote);
    if (output == null) throw new Error("Relay returned no output amount.");
    const minimum = relayMinimumOutput(quote) ?? output;
    const { inUsd, outUsd } = relayUsd(quote);
    return {
      output,
      minOutput: applySlippage(minimum, slippageBps),
      hubAmount,
      hubMinimum: minimum,
      inputUsd: inUsd,
      outputUsd: outUsd,
      bridgeFeeUsd: relayFeeUsd(quote),
    };
  }

  if (kind === "invalid") {
    throw new Error("Unsupported pair.");
  }

  const hubIsEndpoint = tokenKey(to) === tokenKey(USDT_BSC);
  const user = quoteUser(recipient);

  if (hubIsEndpoint) {
    const quote = await getRelayQuote({
      fromChainId: from.chainId,
      fromCurrency: from.address,
      toChainId: BSC_CHAIN_ID,
      toCurrency: USDT_BSC.address,
      amount: amountIn.toString(),
      recipient,
      user: isTronToken(from) ? USDT_TRON_ADDRESS : undefined,
    });
    const hubAmount = relayOutputAmount(quote);
    if (hubAmount == null) throw new Error("Relay returned no output amount.");
    const hubMin = relayMinimumOutput(quote) ?? hubAmount;
    const { inUsd, outUsd } = relayUsd(quote);
    return {
      output: hubAmount,
      minOutput: applySlippage(hubMin, slippageBps),
      hubAmount,
      hubMinimum: hubMin,
      inputUsd: inUsd,
      outputUsd: outUsd,
      bridgeFeeUsd: relayFeeUsd(quote),
    };
  }

  const { path } = await resolveBestBscUsdtPath(to.address);
  const probeTxs = buildDestFillProbeTxs({
    swapId: DEST_FILL_QUOTE_SWAP_ID,
    tokenOut: to.address as Address,
    path,
    user,
  });
  const quote = await getRelayQuote({
    fromChainId: from.chainId,
    fromCurrency: from.address,
    toChainId: BSC_CHAIN_ID,
    toCurrency: USDT_BSC.address,
    amount: amountIn.toString(),
    recipient,
    user: isTronToken(from) ? USDT_TRON_ADDRESS : undefined,
    txs: probeTxs,
    refundOnOrigin: true,
  });
  const fill = await quoteRelayThenBscToken(quote, to, slippageBps);
  return {
    output: fill.output,
    minOutput: fill.minOutput,
    hubAmount: fill.hubExpected,
    hubMinimum: fill.hubMinimum,
    inputUsd: fill.inputUsd,
    outputUsd: fill.outputUsd,
    bridgeFeeUsd: fill.bridgeFeeUsd,
  };
}

export function useQuote(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
  slippageBps = 100,
) {
  return useQuery<QuoteResult>({
    queryKey: [
      "quote",
      tokenKey(from),
      tokenKey(to),
      amountIn.toString(),
      recipient ?? "anon",
      slippageBps,
    ],
    queryFn: () => computeQuote(from, to, amountIn, recipient, slippageBps),
    enabled: amountIn > 0n && tokenKey(from) !== tokenKey(to),
    staleTime: 8_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}
