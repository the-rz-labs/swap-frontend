"use client";

import { useQuery } from "@tanstack/react-query";
import { readContract } from "@wagmi/core";
import { wagmiConfig } from "@/lib/wagmi";
import { BSC_CHAIN_ID, USDT_BSC, tokenKey, type Token } from "@/lib/tokens";
import { RZSWAP_ABI, RZSWAP_ADDRESS, RZSWAP_CONFIGURED, buildBscPath, pathToHub, pathFromHub } from "@/lib/rzswap";
import { getRelayQuote, relayOutputAmount } from "@/lib/relay";
import { classify } from "@/lib/swapPlan";

export type QuoteResult = {
  /** Final output in destination-token base units. */
  output: bigint;
  /** USDT hub amount on BSC, when the route passes through the hub. */
  hubAmount?: bigint;
};

async function rzGetOut(amountIn: bigint, path: readonly `0x${string}`[]): Promise<bigint> {
  if (!RZSWAP_CONFIGURED) throw new Error("RzSwap address is not configured (NEXT_PUBLIC_RZSWAP_ADDRESS).");
  return (await readContract(wagmiConfig, {
    address: RZSWAP_ADDRESS,
    abi: RZSWAP_ABI,
    functionName: "getOutputAmount",
    args: [amountIn, path],
    chainId: BSC_CHAIN_ID,
  })) as bigint;
}

async function computeQuote(from: Token, to: Token, amountIn: bigint, recipient?: string): Promise<QuoteResult> {
  const kind = classify(from, to);

  if (kind === "local") {
    return { output: await rzGetOut(amountIn, buildBscPath(from, to)) };
  }

  if (!recipient) throw new Error("Connect your wallet to quote a cross-chain route.");

  if (kind === "outbound") {
    const hubIsEndpoint = tokenKey(from) === tokenKey(USDT_BSC);
    const hubAmount = hubIsEndpoint ? amountIn : await rzGetOut(amountIn, pathToHub(from));
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
    return { output, hubAmount };
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
  if (hubIsEndpoint) return { output: hubAmount, hubAmount };
  return { output: await rzGetOut(hubAmount, pathFromHub(to)), hubAmount };
}

export function useQuote(from: Token, to: Token, amountIn: bigint, recipient?: string) {
  return useQuery<QuoteResult>({
    queryKey: ["quote", tokenKey(from), tokenKey(to), amountIn.toString(), recipient ?? "anon"],
    queryFn: () => computeQuote(from, to, amountIn, recipient),
    enabled: amountIn > 0n && tokenKey(from) !== tokenKey(to),
    staleTime: 8_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}
