"use client";

import { useQuery } from "@tanstack/react-query";
import { BSC_CHAIN_ID, USDT_BSC, tokenKey, type Token } from "@/lib/tokens";
import { resolveBestBscPath, bscUsdValue } from "@/lib/route";
import { getRelayQuote, relayOutputAmount, relayMinimumOutput, relayUsd } from "@/lib/relay";
import { classify, type SwapMode } from "@/lib/swapPlan";

export type QuoteResult = {
  /** Final output in destination-token base units. */
  output: bigint;
  /** USDT hub amount on BSC, when the route passes through the hub. */
  hubAmount?: bigint;
  /** Best-effort USD value of the input / output. */
  inputUsd?: number;
  outputUsd?: number;
};

async function computeQuote(
  from: Token,
  to: Token,
  amountIn: bigint,
  recipient: string | undefined,
  mode: SwapMode,
): Promise<QuoteResult> {
  // Relay-direct: a single market quote from → to (Relay routes via its own DEX aggregation).
  if (mode === "relay") {
    if (!recipient) throw new Error("Connect your wallet to quote.");
    const quote = await getRelayQuote({
      fromChainId: from.chainId,
      fromCurrency: from.address,
      toChainId: to.chainId,
      toCurrency: to.address,
      amount: amountIn.toString(),
      recipient,
    });
    const output = relayOutputAmount(quote);
    if (output == null) throw new Error("Relay has no route for this pair.");
    const { inUsd, outUsd } = relayUsd(quote);
    return { output, inputUsd: inUsd, outputUsd: outUsd };
  }

  const kind = classify(from, to);

  if (kind === "local") {
    const { amountOut } = await resolveBestBscPath(amountIn, from.address, to.address);
    const [inputUsd, outputUsd] = await Promise.all([bscUsdValue(from, amountIn), bscUsdValue(to, amountOut)]);
    return { output: amountOut, inputUsd, outputUsd };
  }

  if (!recipient) throw new Error("Connect your wallet to quote a cross-chain route.");

  if (kind === "outbound") {
    const hubIsEndpoint = tokenKey(from) === tokenKey(USDT_BSC);
    const hubAmount = hubIsEndpoint
      ? amountIn
      : (await resolveBestBscPath(amountIn, from.address, USDT_BSC.address)).amountOut;
    const quote = await getRelayQuote({
      fromChainId: BSC_CHAIN_ID,
      fromCurrency: USDT_BSC.address,
      toChainId: to.chainId,
      toCurrency: to.address,
      amount: hubAmount.toString(),
      recipient,
    });
    const output = relayOutputAmount(quote);
    if (output == null) throw new Error("Relay returned no output amount.");
    const { inUsd, outUsd } = relayUsd(quote);
    return { output, hubAmount, inputUsd: inUsd, outputUsd: outUsd };
  }

  // inbound
  const hubIsEndpoint = tokenKey(to) === tokenKey(USDT_BSC);
  const quote = await getRelayQuote({
    fromChainId: from.chainId,
    fromCurrency: from.address,
    toChainId: BSC_CHAIN_ID,
    toCurrency: USDT_BSC.address,
    amount: amountIn.toString(),
    recipient,
  });
  const hubExpected = relayOutputAmount(quote);
  const hubMin = relayMinimumOutput(quote) ?? hubExpected;
  if (hubExpected == null || hubMin == null) throw new Error("Relay returned no output amount.");
  const { inUsd, outUsd } = relayUsd(quote);

  // Plain bridge to USDT — the user receives ~expected, no on-arrival swap.
  if (hubIsEndpoint) return { output: hubExpected, hubAmount: hubExpected, inputUsd: inUsd, outputUsd: outUsd };

  // Bridge-and-execute: the on-arrival swap is pinned to the bridge's GUARANTEED MINIMUM (×0.99),
  // so quote the RZ output from that exact amount — matching execution. Quoting from `hubExpected`
  // would overstate what the user actually receives (the bug this fixes).
  const swapIn = (hubMin * 99n) / 100n;
  const { amountOut } = await resolveBestBscPath(swapIn, USDT_BSC.address, to.address);
  // Scale the output USD to the minimum so the $ value tracks the shown amount.
  const outputUsd = outUsd != null && hubExpected > 0n ? (outUsd * Number(hubMin)) / Number(hubExpected) : outUsd;
  return { output: amountOut, hubAmount: hubMin, inputUsd: inUsd, outputUsd };
}

export function useQuote(from: Token, to: Token, amountIn: bigint, recipient: string | undefined, mode: SwapMode) {
  return useQuery<QuoteResult>({
    queryKey: ["quote", mode, tokenKey(from), tokenKey(to), amountIn.toString(), recipient ?? "anon"],
    queryFn: () => computeQuote(from, to, amountIn, recipient, mode),
    enabled: amountIn > 0n && tokenKey(from) !== tokenKey(to),
    staleTime: 8_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}
