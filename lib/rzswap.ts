import type { Address } from "viem";
import { getAddress } from "viem";
import { USDT_BSC, type Token } from "./tokens";

/** Deployed RzSwap address on BSC. Set NEXT_PUBLIC_RZSWAP_ADDRESS after deploying. */
export const RZSWAP_ADDRESS = (process.env.NEXT_PUBLIC_RZSWAP_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as Address;

export const RZSWAP_CONFIGURED =
  RZSWAP_ADDRESS.toLowerCase() !== "0x0000000000000000000000000000000000000000";

/** Minimal ABI: only the entry points the frontend calls. */
export const RZSWAP_ABI = [
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "minAmountOut", type: "uint256" },
          { name: "receiver", type: "address" },
          { name: "path", type: "address[]" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "getOutputAmount",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "getLiquidityBalance",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "supportedToken",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

/**
 * Builds the PancakeSwap routing path the RzSwap contract validates and prices against.
 * `from` and `to` must both be BSC tokens; optional `bscRouteHops` are inserted between them.
 */
export function buildBscPath(from: Token, to: Token): Address[] {
  const hops = from.bscRouteHops ?? to.bscRouteHops ?? [];
  return [getAddress(from.address), ...hops.map(getAddress), getAddress(to.address)];
}

/** Path for the rz-token → USDT hub leg of an outbound swap. */
export function pathToHub(from: Token): Address[] {
  return buildBscPath(from, USDT_BSC);
}

/** Path for the USDT hub → rz-token leg of an inbound swap. */
export function pathFromHub(to: Token): Address[] {
  return buildBscPath(USDT_BSC, to);
}
