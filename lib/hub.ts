/**
 * Hub selection for GOLDGR routes. Non-GOLDGR flows never import this — they keep using
 * BSC-only constants in gateway.ts / useSwapFlow.
 *
 * Next.js only inlines statically referenced `process.env.NEXT_PUBLIC_*` keys — never use
 * `process.env[name]` (that always resolves to undefined in the client bundle).
 * Defaults match DEPLOYMENTS.md (Ethereum GOLDGR stack + live BSC gateway).
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

/** Relay depository — same address on BSC + ETH (verified via /quote). */
const RELAY_DEPOSITORY = "0x4cD00E387622C35bDDB9b4c962C136462338BC31" as Address;

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
  gateway: (process.env.NEXT_PUBLIC_RZ_GATEWAY ?? "0x8Fbe29393Fe26A9aFaaa68644874f9Ca7b88f3f2") as Address,
  vault: (process.env.NEXT_PUBLIC_RZSWAP_ADDRESS ?? "0x375B3955e58c0D77ea5F5436ED8413c189DB5B52") as Address,
  usdt: USDT_BSC,
  adapter: (process.env.NEXT_PUBLIC_RELAY_DEPOSIT_ADAPTER ?? "0x23aEF67e28BeF01a5e64fFefdd66383FE2457ae4") as Address,
  depository: RELAY_DEPOSITORY,
};

export const ETH_HUB: Hub = {
  chainId: ETH_CHAIN_ID,
  // DeployEthereumFullStack — DEPLOYMENTS.md
  gateway: (process.env.NEXT_PUBLIC_ETH_RZ_GATEWAY ?? "0xd2471055174319f30A441c856e6E5577f4a852B0") as Address,
  vault: (process.env.NEXT_PUBLIC_ETH_RZSWAP_ADDRESS ?? "0xB13Dcac1AEd9ebf08206cA1B64F4f678609E7622") as Address,
  usdt: USDT_ETH,
  adapter: (process.env.NEXT_PUBLIC_ETH_RELAY_DEPOSIT_ADAPTER ?? "0xF1870A68dB291ed8B2c90605505893D0545c26aD") as Address,
  depository: (process.env.NEXT_PUBLIC_ETH_RELAY_DEPOSITORY ?? RELAY_DEPOSITORY) as Address,
  weth: WETH_ADDRESS,
};

/** ETH buy fill proxy — required for USDT→GOLDGR (and other ETH hub buys). */
export const ETH_USDT_FILL_ADAPTER = (process.env.NEXT_PUBLIC_ETH_USDT_FILL_ADAPTER ??
  "0x4E221f8270737aA478F7967FE04Bb1707f30E993") as Address;

export function ethHubConfigured(): boolean {
  return ETH_HUB.gateway !== ZERO && ETH_HUB.vault !== ZERO;
}

export function ethBuyFillConfigured(): boolean {
  return ethHubConfigured() && ETH_USDT_FILL_ADAPTER !== ZERO;
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
