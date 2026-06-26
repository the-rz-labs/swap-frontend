"use client";

import { useQuery } from "@tanstack/react-query";
import { multicall, getBalance } from "@wagmi/core";
import { wagmiConfig, type AppChainId } from "@/lib/wagmi";
import { ERC20_ABI } from "@/lib/rzswap";
import { isNative, tokenKey, vmOf, type Token } from "@/lib/tokens";
import { getTrc20Balance } from "@/lib/tron/tronGrid";

/**
 * Fetches balances for a set of tokens, keyed by tokenKey. EVM tokens are read via wagmi (multicall +
 * native getBalance) using `address`; Tron (TRC-20) tokens are read via TronGrid using `tronAddress`.
 */
export function useBalances(tokens: Token[], address?: string, tronAddress?: string) {
  return useQuery<Record<string, bigint>>({
    queryKey: ["balances", address ?? "anon", tronAddress ?? "", tokens.map(tokenKey).join(",")],
    enabled: (!!address || !!tronAddress) && tokens.length > 0,
    staleTime: 12_000,
    queryFn: async () => {
      const out: Record<string, bigint> = {};

      // ── EVM (wagmi) ──
      if (address) {
        const byChain = new Map<number, Token[]>();
        for (const t of tokens) {
          if (vmOf(t) !== "evm") continue;
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
                chainId: chainId as AppChainId,
                allowFailure: true,
                contracts: erc.map((t) => ({
                  address: t.address as `0x${string}`,
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
                  const b = await getBalance(wagmiConfig, { address: address as `0x${string}`, chainId: chainId as AppChainId });
                  out[tokenKey(t)] = b.value;
                } catch {
                  out[tokenKey(t)] = 0n;
                }
              }),
            );
          }),
        );
      }

      // ── Tron (TronGrid) ──
      if (tronAddress) {
        const tronTokens = tokens.filter((t) => vmOf(t) === "tvm");
        await Promise.all(
          tronTokens.map(async (t) => {
            try {
              out[tokenKey(t)] = isNative(t) ? 0n : await getTrc20Balance(tronAddress, t.address);
            } catch {
              out[tokenKey(t)] = 0n;
            }
          }),
        );
      }

      return out;
    },
  });
}
