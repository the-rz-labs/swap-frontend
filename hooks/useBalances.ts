"use client";

import { useQuery } from "@tanstack/react-query";
import { multicall, getBalance } from "@wagmi/core";
import { wagmiConfig } from "@/lib/wagmi";
import { ERC20_ABI } from "@/lib/rzswap";
import { isNative, tokenKey, type Token } from "@/lib/tokens";

/** Fetches balances for a set of tokens (ERC-20 via multicall + native via getBalance), keyed by tokenKey. */
export function useBalances(tokens: Token[], address?: string) {
  return useQuery<Record<string, bigint>>({
    queryKey: ["balances", address ?? "anon", tokens.map(tokenKey).join(",")],
    enabled: !!address && tokens.length > 0,
    staleTime: 12_000,
    queryFn: async () => {
      const out: Record<string, bigint> = {};
      const byChain = new Map<number, Token[]>();
      for (const t of tokens) {
        const list = byChain.get(t.chainId) ?? [];
        list.push(t);
        byChain.set(t.chainId, list);
      }

      await Promise.all(
        [...byChain.entries()].map(async ([chainId, list]) => {
          const erc = list.filter((t) => !isNative(t));
          const native = list.filter(isNative);

          if (erc.length > 0) {
            const res = await multicall(wagmiConfig, {
              chainId,
              allowFailure: true,
              contracts: erc.map((t) => ({
                address: t.address,
                abi: ERC20_ABI,
                functionName: "balanceOf" as const,
                args: [address as `0x${string}`],
              })),
            });
            res.forEach((r, i) => {
              out[tokenKey(erc[i])] = r.status === "success" ? (r.result as bigint) : 0n;
            });
          }

          await Promise.all(
            native.map(async (t) => {
              try {
                const b = await getBalance(wagmiConfig, { address: address as `0x${string}`, chainId });
                out[tokenKey(t)] = b.value;
              } catch {
                out[tokenKey(t)] = 0n;
              }
            }),
          );
        }),
      );

      return out;
    },
  });
}
