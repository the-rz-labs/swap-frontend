"use client";

import { useQuery } from "@tanstack/react-query";
import { tokenKey, type Token } from "@/lib/tokens";
import { computeBestQuote, type QuoteResult } from "@/lib/relayQuote";

export type { QuoteResult };

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
    queryFn: () => computeBestQuote(from, to, amountIn, recipient, slippageBps),
    enabled: amountIn > 0n && tokenKey(from) !== tokenKey(to),
    staleTime: 8_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}
