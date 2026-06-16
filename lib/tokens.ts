import type { Address } from "viem";

export const BSC_CHAIN_ID = 56;

/** Relay (and most aggregators) represent a chain's native currency with the zero address. */
export const NATIVE_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Wrapped BNB — the dominant PancakeSwap base pair; used as a routing intermediary. */
export const WBNB_ADDRESS: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

export type Token = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  chainId: number;
  /** Marks the BSC token used as the bridge intermediary between Relay and RzSwap. */
  isHubIntermediary?: boolean;
};

/**
 * The 17 BSC tokens RzSwap supports. USDT_BSC is the hub intermediary that bridges to/from Relay.
 *
 * NOTE: decimals default to 18 (BSC convention, incl. BSC-USDT). Verify on-chain before mainnet
 * use — the UI also reads decimals dynamically where it can.
 */
export const BSC_TOKENS: Token[] = [
  { symbol: "USDT", name: "Tether USD (BSC)", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, chainId: BSC_CHAIN_ID, isHubIntermediary: true },
  { symbol: "MGC", name: "MGC", address: "0xbb73BB2505AC4643d5C0a99c2A1F34B3DfD09D11", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "REALESTATE", name: "Real Estate", address: "0x32477cf0e324f9a9cb49e8803fa4de9f80f8d0d4", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "RZ", name: "RZ", address: "0x6BC5AbCc56874D7fACb90C2c3812cc19aAf9B204", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "RZUSD", name: "RZ USD", address: "0xc4a1cc5ca8955a4650bdc109bddf110e33a1e344", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "INSURANCE", name: "Insurance", address: "0x64E4fea6e4F3637025c7Bcd878E2B238B01f7D4e", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "JEWELRY", name: "Jewelry", address: "0xf04FaB6Dda66261eaBfD65e92A6b81dDaF6a950a", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "CZW", name: "CZW", address: "0xb2054b867c503350927930d0302528b9825d0db5", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "RP1", name: "RP1", address: "0x1a694db0d264ebd10d2620270e2618784039f92f", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "COINBANK", name: "CoinBank", address: "0xf19c362d779ade83d4f8708c6c36297b6ad57528", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "OASIS", name: "Oasis", address: "0x1a4d41219c547f3a0ee36cf3d9e68f80699cf283", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "ZGC", name: "ZGC", address: "0xAd4f3b563f2363e7593DDCaaB322604CeDF55952", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "BTCR", name: "BTCR", address: "0xfed8bf93ece0a2c6da6def9c3eb370008b3a4450", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "CAR", name: "Car", address: "0xBB1106c7dEb7cC60EfA51391760b14aEd8CB5BEd", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "INDUSTRIAL", name: "Industrial", address: "0x9e06e1203bdc3747ee3ab5fa9488619bcf2a2666", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "TRIP", name: "Trip", address: "0xC9Bfb93d75645c4681BB63794ABf1acAD44725e7", decimals: 18, chainId: BSC_CHAIN_ID },
  { symbol: "LIFE", name: "Life", address: "0x488535e0a2503252798f381b2df08a6280e994b2", decimals: 18, chainId: BSC_CHAIN_ID },
];

export const USDT_BSC: Token = BSC_TOKENS.find((t) => t.isHubIntermediary)!;

/** Curated cross-chain origin/destination tokens routed through Relay. Extend as needed. */
export const REMOTE_TOKENS: Token[] = [
  { symbol: "ETH", name: "Ethereum", address: NATIVE_ADDRESS, decimals: 18, chainId: 1 },
  { symbol: "USDT", name: "Tether USD", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, chainId: 1 },
  { symbol: "USDC", name: "USD Coin", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, chainId: 1 },
  { symbol: "ETH", name: "Ethereum (Arbitrum)", address: NATIVE_ADDRESS, decimals: 18, chainId: 42161 },
  { symbol: "USDC", name: "USD Coin (Arbitrum)", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, chainId: 42161 },
  { symbol: "ETH", name: "Ethereum (Base)", address: NATIVE_ADDRESS, decimals: 18, chainId: 8453 },
  { symbol: "USDC", name: "USD Coin (Base)", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, chainId: 8453 },
  { symbol: "ETH", name: "Ethereum (Optimism)", address: NATIVE_ADDRESS, decimals: 18, chainId: 10 },
  { symbol: "POL", name: "Polygon", address: NATIVE_ADDRESS, decimals: 18, chainId: 137 },
  { symbol: "USDC", name: "USD Coin (Polygon)", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, chainId: 137 },
];

export const CHAIN_NAMES: Record<number, string> = {
  56: "BNB Chain",
  1: "Ethereum",
  42161: "Arbitrum",
  8453: "Base",
  10: "Optimism",
  137: "Polygon",
};

export function isBscToken(t: Token): boolean {
  return t.chainId === BSC_CHAIN_ID;
}

export function isNative(t: Token): boolean {
  return t.address.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
}

export function tokenKey(t: Token): string {
  return `${t.chainId}:${t.address.toLowerCase()}`;
}
