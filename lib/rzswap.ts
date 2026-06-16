import type { Address } from "viem";

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
  // ── custom errors (so viem can decode reverts to readable names) ──
  { type: "error", name: "UnsupportedToken", inputs: [] },
  { type: "error", name: "SlippageExceeded", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "InvalidReceiver", inputs: [] },
  { type: "error", name: "InvalidTransfer", inputs: [] },
  { type: "error", name: "InsufficientLiquidity", inputs: [] },
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "InvalidAddress", inputs: [] },
  { type: "error", name: "InvalidPath", inputs: [] },
  { type: "error", name: "PricingFailed", inputs: [] },
  { type: "error", name: "TimelockActive", inputs: [{ name: "activatesAt", type: "uint256" }] },
  { type: "error", name: "NativeTransferFailed", inputs: [] },
  { type: "error", name: "EnforcedPause", inputs: [] },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;
