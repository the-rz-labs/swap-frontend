/**
 * Hub selection for GOLDGR routes. Non-GOLDGR flows never import this — they keep using
 * BSC-only constants in gateway.ts / useSwapFlow.
 */
import type { Address } from "viem";
import {
  BSC_CHAIN_ID,
  ETH_CHAIN_ID,
  GOLDGR,
  USDT_BSC,
  USDT_ETH,
  WETH_ADDRESS,
  isGoldgr,
  isBscToken,
  tokenKey,
  type Token,
} from "./tokens";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function envAddr(name: string, fallback = ZERO): Address {
  return (process.env[name] ?? fallback) as Address;
}

export type Hub = {
  chainId: number;
  gateway: Address;
  vault: Address;
  usdt: Token;
  adapter: Address;
  depository: Address;
  /** Pancake/Uniswap path hop for ETH GOLDGR (undefined on BSC). */
  weth?: Address;
};

export const BSC_HUB: Hub = {
  chainId: BSC_CHAIN_ID,
  gateway: envAddr("NEXT_PUBLIC_RZ_GATEWAY"),
  vault: envAddr("NEXT_PUBLIC_RZSWAP_ADDRESS"),
  usdt: USDT_BSC,
  adapter: envAddr("NEXT_PUBLIC_RELAY_DEPOSIT_ADAPTER"),
  depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" as Address,
};

export const ETH_HUB: Hub = {
  chainId: ETH_CHAIN_ID,
  gateway: envAddr("NEXT_PUBLIC_ETH_RZ_GATEWAY"),
  vault: envAddr("NEXT_PUBLIC_ETH_RZSWAP_ADDRESS"),
  usdt: USDT_ETH,
  adapter: envAddr("NEXT_PUBLIC_ETH_RELAY_DEPOSIT_ADAPTER"),
  depository: envAddr("NEXT_PUBLIC_ETH_RELAY_DEPOSITORY"),
  weth: WETH_ADDRESS,
};

export function ethHubConfigured(): boolean {
  return ETH_HUB.gateway !== ZERO && ETH_HUB.vault !== ZERO;
}

export function ethSellConfigured(): boolean {
  return ethHubConfigured() && ETH_HUB.adapter !== ZERO && ETH_HUB.depository !== ZERO;
}

/** Canonical ETH GOLDGR paths (WETH hop). */
export function ethGoldgrPath(from: Token, to: Token): Address[] {
  const usdt = USDT_ETH.address as Address;
  const gold = GOLDGR.address as Address;
  const weth = WETH_ADDRESS;
  if (tokenKey(from) === tokenKey(USDT_ETH) && isGoldgr(to)) return [usdt, weth, gold];
  if (isGoldgr(from) && tokenKey(to) === tokenKey(USDT_ETH)) return [gold, weth, usdt];
  throw new Error("ETH GOLDGR path only supports USDT ↔ GOLDGR");
}

/**
 * Which hub originates the user tx for a GOLDGR-involving pair.
 * - Sell GOLDGR / local ETH → ETH hub
 * - BSC → GOLDGR → BSC hub (sell) with ETH fulfillBuy on dest
 * - Buy GOLDGR from remote → source chain signs Relay; dest hub is ETH
 */
export function originHubForGoldgr(from: Token, _to: Token): Hub {
  if (isGoldgr(from) || (from.chainId === ETH_CHAIN_ID && isEthTreasuryPair(from, _to))) {
    return ETH_HUB;
  }
  if (isBscToken(from)) return BSC_HUB;
  // Remote buy into GOLDGR — no origin hub contract; ETH is destination only.
  return ETH_HUB;
}

function isEthTreasuryPair(a: Token, b: Token): boolean {
  const keys = new Set([tokenKey(a), tokenKey(b)]);
  return keys.has(tokenKey(USDT_ETH)) && keys.has(tokenKey(GOLDGR));
}
