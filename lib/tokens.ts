import type { Address } from "viem";

export const BSC_CHAIN_ID = 56;
export const ETH_CHAIN_ID = 1;
/** Relay's chain id for Tron (vmType "tvm"). Tron is a Relay endpoint only — no contract there. */
export const TRON_CHAIN_ID = 728126428;

/** Relay (and most aggregators) represent a chain's native currency with the zero address. */
export const NATIVE_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
/** Relay's marker address for native TRX on Tron (the Tron "zero" account, base58). */
export const TRX_NATIVE_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

/** Wrapped BNB — the dominant PancakeSwap base pair; used as a routing intermediary. */
export const WBNB_ADDRESS: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const TW = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains";

export type ChainMeta = { id: number; name: string; shortName: string; logoURI: string };

export const CHAINS: Record<number, ChainMeta> = {
  [BSC_CHAIN_ID]: { id: BSC_CHAIN_ID, name: "BNB Chain", shortName: "BSC", logoURI: `${TW}/smartchain/info/logo.png` },
  [ETH_CHAIN_ID]: { id: ETH_CHAIN_ID, name: "Ethereum", shortName: "Ethereum", logoURI: `${TW}/ethereum/info/logo.png` },
  [TRON_CHAIN_ID]: { id: TRON_CHAIN_ID, name: "Tron", shortName: "Tron", logoURI: `${TW}/tron/info/logo.png` },
};

/** VM family of a token's chain. Tron ("tvm") addresses are base58, not 0x-hex. */
export type TokenVm = "evm" | "tvm";

export type Token = {
  symbol: string;
  name: string;
  /** EVM: 0x 20-byte hex. Tron: base58 (`T…`). Tron tokens are only ever the Relay remote leg and
   *  never reach a viem/EVM call (those paths are guarded by isBscToken), so `string` is safe. */
  address: string;
  decimals: number;
  chainId: number;
  /** Defaults to "evm" when absent. */
  vm?: TokenVm;
  /** Logo URL; falls back to a generated avatar when absent or it 404s. */
  logoURI?: string;
  /** Marks the BSC token used as the bridge intermediary between Relay and RzSwap. */
  isHubIntermediary?: boolean;
};

/**
 * The 17 BSC tokens RzSwap supports. USDT_BSC is the hub intermediary that bridges to/from Relay.
 * RZ-ecosystem tokens have no public logos → they render as generated avatars.
 *
 * NOTE: decimals default to 18 (BSC convention, incl. BSC-USDT). Verify on-chain before mainnet use.
 */
export const BSC_TOKENS: Token[] = [
  { symbol: "USDT", name: "Tether USD", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, chainId: BSC_CHAIN_ID, isHubIntermediary: true, logoURI: `${TW}/smartchain/assets/0x55d398326f99059fF775485246999027B3197955/logo.png` },
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

/** USDT (TRC-20) on Tron. Also used as a FUNDED representative recipient for pre-address fee estimates
 *  (the Tron delivery fee depends on the recipient; the native zero-address marker quotes anomalously
 *  cheap, so we estimate against a real funded address instead). */
export const USDT_TRON_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/** WETH — ETH hub path hop for GOLDGR (not held as inventory). */
export const WETH_ADDRESS: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/** USDT on Ethereum (6-dec) — ETH treasury stable / Relay dest currency for GOLDGR buys. */
export const USDT_ETH: Token = {
  symbol: "USDT",
  name: "Tether USD",
  address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  decimals: 6,
  chainId: ETH_CHAIN_ID,
  isHubIntermediary: true,
  logoURI: `${TW}/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png`,
};

/** GOLDGR on Ethereum — ETH treasury inventory token (never bridges). */
export const GOLDGR: Token = {
  symbol: "GOLDGR",
  name: "GOLDGR",
  address: "0x957E0fDfbd1c2F97648318B2f057E327996EC367",
  decimals: 18,
  chainId: ETH_CHAIN_ID,
};

/**
 * Cross-chain tokens on Ethereum.
 * USDT appears once (USDT_ETH) — hub for GOLDGR local/buy/sell.
 * ETH/USDC remain Relay remotes for non-GOLDGR routes and GOLDGR buys via Relay→USDT.
 */
export const REMOTE_TOKENS: Token[] = [
  { symbol: "ETH", name: "Ethereum", address: NATIVE_ADDRESS, decimals: 18, chainId: ETH_CHAIN_ID, logoURI: `${TW}/ethereum/info/logo.png` },
  USDT_ETH,
  { symbol: "USDC", name: "USD Coin", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, chainId: ETH_CHAIN_ID, logoURI: `${TW}/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png` },
  GOLDGR,
];

/**
 * Tron tokens routed through Relay (6 decimals, base58 addresses). No contract on Tron.
 * Only USDT (TRC-20) is offered: Relay's Tron support is USDT-only — there is no swap route to native
 * TRX as a destination (USDT->TRX returns NO_SWAP_ROUTES_FOUND), so TRX is intentionally omitted.
 */
export const TRON_TOKENS: Token[] = [
  { symbol: "USDT", name: "Tether USD", address: USDT_TRON_ADDRESS, decimals: 6, chainId: TRON_CHAIN_ID, vm: "tvm", logoURI: `${TW}/tron/assets/${USDT_TRON_ADDRESS}/logo.png` },
];

export const ALL_TOKENS: Token[] = [...BSC_TOKENS, ...REMOTE_TOKENS, ...TRON_TOKENS];

export const CHAIN_NAMES: Record<number, string> = {
  [BSC_CHAIN_ID]: "BNB Chain",
  [ETH_CHAIN_ID]: "Ethereum",
  [TRON_CHAIN_ID]: "Tron",
};

export function vmOf(t: Token): TokenVm {
  return t.vm ?? "evm";
}

export function isBscToken(t: Token): boolean {
  return t.chainId === BSC_CHAIN_ID;
}

export function isTronToken(t: Token): boolean {
  return t.chainId === TRON_CHAIN_ID;
}

export function isEthToken(t: Token): boolean {
  return t.chainId === ETH_CHAIN_ID;
}

export function isGoldgr(t: Token): boolean {
  return tokenKey(t) === tokenKey(GOLDGR);
}

/** True when either side of the pair is GOLDGR — FE GOLDGR hub branch gate. */
export function involvesGoldgr(from: Token, to: Token): boolean {
  return isGoldgr(from) || isGoldgr(to);
}

/** ETH treasury inventory tokens (USDT hub + GOLDGR). */
export function isEthTreasuryToken(t: Token): boolean {
  return tokenKey(t) === tokenKey(USDT_ETH) || isGoldgr(t);
}

export function isNative(t: Token): boolean {
  const a = t.address.toLowerCase();
  return a === NATIVE_ADDRESS.toLowerCase() || a === TRX_NATIVE_ADDRESS.toLowerCase();
}

export function tokenKey(t: Token): string {
  return `${t.chainId}:${t.address.toLowerCase()}`;
}
