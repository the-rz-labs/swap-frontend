"use client";

import { useQuery } from "@tanstack/react-query";
import { BSC_CHAIN_ID, USDT_BSC, tokenKey, type Token } from "@/lib/tokens";
import { resolveBestBscPath, bscUsdValue } from "@/lib/route";
import { getRelayQuote, relayOutputAmount, relayUsd } from "@/lib/relay";
import { classify } from "@/lib/swapPlan";

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
): Promise<QuoteResult> {
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
  const hubAmount = relayOutputAmount(quote);
  if (hubAmount == null) throw new Error("Relay returned no output amount.");
  const { inUsd, outUsd } = relayUsd(quote);

  // Plain bridge to USDT — the user receives ~expected, no on-arrival swap.
  if (hubIsEndpoint) return { output: hubAmount, hubAmount, inputUsd: inUsd, outputUsd: outUsd };

  // Buy: the fill swaps the bridged USDT into the token via RzSwap, so quote the token output from
  // the expected bridged USDT amount.
  const { amountOut } = await resolveBestBscPath(hubAmount, USDT_BSC.address, to.address);
  return { output: amountOut, hubAmount, inputUsd: inUsd, outputUsd: outUsd };
}

export function useQuote(from: Token, to: Token, amountIn: bigint, recipient: string | undefined) {
  return useQuery<QuoteResult>({
    queryKey: ["quote", tokenKey(from), tokenKey(to), amountIn.toString(), recipient ?? "anon"],
    queryFn: () => computeQuote(from, to, amountIn, recipient),
    enabled: amountIn > 0n && tokenKey(from) !== tokenKey(to),
    staleTime: 8_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}
