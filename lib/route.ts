import type { Address } from "viem";
import { getAddress, formatUnits } from "viem";
import { readContract } from "@wagmi/core";
import { wagmiConfig } from "./wagmi";
import { BSC_CHAIN_ID, ETH_CHAIN_ID, USDT_BSC, USDT_ETH, WBNB_ADDRESS, tokenKey, type Token } from "./tokens";
import { RZSWAP_ABI, RZSWAP_ADDRESS, RZSWAP_CONFIGURED } from "./rzswap";
import { ETH_HUB, ethGoldgrPath, ethHubConfigured } from "./hub";

/**
 * Candidate intermediary hops tried when resolving a BSC swap path. Many RZ tokens have no direct
 * USDT pair on PancakeSwap (e.g. CAR only pairs with WBNB), so we probe these bases and keep the
 * route that yields the best on-chain quote — mirroring how a real router picks a path.
 */
const INTERMEDIARIES: Address[] = [
  getAddress(WBNB_ADDRESS),
  getAddress(USDT_BSC.address),
  getAddress("0xc4a1cc5ca8955a4650bdc109bddf110e33a1e344"), // RZUSD
];

export type ResolvedRoute = { path: Address[]; amountOut: bigint };

function candidatePaths(from: Address, to: Address): Address[][] {
  const paths: Address[][] = [[from, to]];
  for (const mid of INTERMEDIARIES) {
    if (mid === from || mid === to) continue; // would create an adjacent duplicate
    paths.push([from, mid, to]);
  }
  return paths;
}

async function quotePath(amountIn: bigint, path: Address[]): Promise<bigint | null> {
  try {
    const out = (await readContract(wagmiConfig, {
      address: RZSWAP_ADDRESS,
      abi: RZSWAP_ABI,
      functionName: "getOutputAmount",
      args: [amountIn, path],
      chainId: BSC_CHAIN_ID,
    })) as bigint;
    return out > 0n ? out : null;
  } catch {
    return null; // dead pair / pricing failure for this candidate
  }
}

/**
 * 1 whole BSC-USDT. Use when we only need a viable path (dest-fill probes), not a size quote.
 * 1 wei fails the unit-price PricingSystem (router out rounds to 0 → PricingFailed).
 */
export const BSC_USDT_PATH_PROBE = 10n ** 18n;

/**
 * Resolves the best PancakeSwap path between two BSC tokens by quoting each candidate on-chain and
 * keeping the highest output. Throws if no candidate has liquidity.
 */
export async function resolveBestBscPath(amountIn: bigint, from: string, to: string): Promise<ResolvedRoute> {
  if (!RZSWAP_CONFIGURED) throw new Error("RzSwap address is not configured (NEXT_PUBLIC_RZSWAP_ADDRESS).");
  const f = getAddress(from);
  const t = getAddress(to);

  const candidates = candidatePaths(f, t);
  const results = await Promise.all(candidates.map((p) => quotePath(amountIn, p)));

  let best: ResolvedRoute | undefined;
  results.forEach((out, i) => {
    if (out != null && (!best || out > best.amountOut)) best = { path: candidates[i], amountOut: out };
  });

  if (!best) {
    throw new Error(
      "No price available for this pair — low liquidity, or the AMM price deviates too far from the " +
        "oracle (the v1 PricingSystem caps deviation). Installing the OraclePricer prices these tokens.",
    );
  }
  return best;
}

/** Path discovery from BSC-USDT → tokenOut using a 1-USDT probe (not 1 wei). */
export async function resolveBestBscUsdtPath(tokenOut: string): Promise<ResolvedRoute> {
  return resolveBestBscPath(BSC_USDT_PATH_PROBE, USDT_BSC.address, tokenOut);
}

/**
 * Approximate USD value of a BSC token amount, by quoting it to USDT (≈ $1). Returns undefined if
 * no route exists. USDT itself is treated as $1.
 */
export async function bscUsdValue(token: Token, amount: bigint): Promise<number | undefined> {
  if (amount <= 0n) return 0;
  if (tokenKey(token) === tokenKey(USDT_BSC)) return Number(formatUnits(amount, 18));
  try {
    const { amountOut } = await resolveBestBscPath(amount, token.address, USDT_BSC.address);
    return Number(formatUnits(amountOut, 18));
  } catch {
    return undefined;
  }
}

/**
 * Quotes the fixed ETH GOLDGR path (USDT ↔ GOLDGR via WETH) on the ETH RzSwap vault.
 * Leaves `resolveBestBscPath` untouched — GOLDGR never uses BSC path probing.
 */
export async function resolveEthGoldgrPath(amountIn: bigint, from: Token, to: Token): Promise<ResolvedRoute> {
  if (!ethHubConfigured()) {
    throw new Error("ETH RzSwap is not configured (set NEXT_PUBLIC_ETH_RZSWAP_ADDRESS / NEXT_PUBLIC_ETH_RZ_GATEWAY).");
  }
  const path = ethGoldgrPath(from, to);
  const out = (await readContract(wagmiConfig, {
    address: ETH_HUB.vault,
    abi: RZSWAP_ABI,
    functionName: "getOutputAmount",
    args: [amountIn, path],
    chainId: ETH_CHAIN_ID,
  })) as bigint;
  if (out <= 0n) throw new Error("No ETH GOLDGR quote — check treasury liquidity / pricing.");
  return { path, amountOut: out };
}

/** Approximate USD of an ETH treasury amount (USDT 6-dec ≈ $1, GOLDGR via USDT quote). */
export async function ethUsdValue(token: Token, amount: bigint): Promise<number | undefined> {
  if (amount <= 0n) return 0;
  if (tokenKey(token) === tokenKey(USDT_ETH)) return Number(formatUnits(amount, USDT_ETH.decimals));
  try {
    const { amountOut } = await resolveEthGoldgrPath(amount, token, USDT_ETH);
    return Number(formatUnits(amountOut, USDT_ETH.decimals));
  } catch {
    return undefined;
  }
}
