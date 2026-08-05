/**
 * RzGateway — the single contract the frontend uses for ALL swaps (local / buy / sell).
 *
 *  - LOCAL : RzGateway.swapLocal(...)                          (1 approve + 1 call)
 *  - BUY BSC : Relay cleanupErc20sViaCall → gateway.fulfillBuy (approve-then-call; BSC USDT OK)
 *  - BUY ETH : Relay cleanupErc20s (safeTransfer) → EthUsdtFillAdapter.fill → gateway.fulfillBuy
 *              (mainnet USDT breaks raw approve inside cleanupErc20sViaCall)
 *  - SELL  : RzGateway.sell(...) — swaps token->USDT via the engine then bridges out via the adapter.
 *
 * See docs/DESIGN.md for the verified Relay delivery model.
 */
import { type Address, type Hex, encodeFunctionData, encodeAbiParameters } from "viem";
import { USDT_BSC, BSC_CHAIN_ID } from "./tokens";
import type { RelayCallTx } from "./relay";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const USDT = USDT_BSC.address as Address;

// ── deployed addresses (env) ─────────────────────────────────────────────────
export const RZ_GATEWAY = (process.env.NEXT_PUBLIC_RZ_GATEWAY ?? ZERO) as Address;
export const RELAY_DEPOSIT_ADAPTER = (process.env.NEXT_PUBLIC_RELAY_DEPOSIT_ADAPTER ?? ZERO) as Address;
/// Relay's RelayRouterV3 on BSC — executes the buy's destination call (cleanupErc20sViaCall).
export const RELAY_ROUTER = (process.env.NEXT_PUBLIC_RELAY_ROUTER ??
  "0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f") as Address;
/// ETH-only: USDT-safe fill proxy (cleanupErc20s → fill → gateway).
export const ETH_USDT_FILL_ADAPTER = (process.env.NEXT_PUBLIC_ETH_USDT_FILL_ADAPTER ??
  "0x4E221f8270737aA478F7967FE04Bb1707f30E993") as Address;

export const GATEWAY_CONFIGURED = RZ_GATEWAY !== ZERO;
export const BUY_DESTINATION_CHAIN = BSC_CHAIN_ID;

// ── ABIs ─────────────────────────────────────────────────────────────────────
export const RZ_GATEWAY_ABI = [
  {
    type: "function",
    name: "swapLocal",
    stateMutability: "nonpayable",
    inputs: [
      { name: "swapId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minOut", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "fulfillBuy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "swapId", type: "bytes32" },
      { name: "tokenOut", type: "address" },
      { name: "minOut", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "payable",
    inputs: [
      { name: "swapId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minStableOut", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "adapter", type: "address" },
      { name: "dstChainId", type: "uint256" },
      { name: "recipient", type: "bytes" },
      { name: "extraData", type: "bytes" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/// Relay RelayRouterV3.cleanupErc20sViaCall — for amount 0 it approves `to` for the router's full
/// `token` balance, then calls `to` with `data`. Used on BSC (USDT returns bool).
const CLEANUP_VIA_CALL_ABI = [
  {
    type: "function",
    name: "cleanupErc20sViaCall",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokens", type: "address[]" },
      { name: "tos", type: "address[]" },
      { name: "datas", type: "bytes[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

/// Relay RelayRouterV3.cleanupErc20s — safeTransfer full balance (amount 0). USDT-safe on ETH.
/// Live router uses the 4-arg form (trailing `bytes`); the 3-arg form is NOT deployed.
const CLEANUP_ERC20S_ABI = [
  {
    type: "function",
    name: "cleanupErc20s",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokens", type: "address[]" },
      { name: "recipients", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const ETH_FILL_ADAPTER_ABI = [
  {
    type: "function",
    name: "fill",
    stateMutability: "nonpayable",
    inputs: [
      { name: "swapId", type: "bytes32" },
      { name: "tokenOut", type: "address" },
      { name: "minOut", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Random 32-byte swapId for backend reconciliation (echoed in SwapExecuted). */
export function generateSwapId(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
}

/**
 * BUY destination call (BSC): router cleanupErc20sViaCall → gateway.fulfillBuy.
 * `recipient` on the Relay quote MUST be the user, NOT the router.
 */
export function buildBuyTxs(args: {
  swapId: Hex;
  tokenOut: Address;
  minOut: bigint;
  path: Address[];
  user: Address;
  /** Destination hub gateway (default: BSC RzGateway). */
  gateway?: Address;
  /** Destination hub USDT (default: BSC USDT). */
  usdt?: Address;
  /** Relay router that executes cleanupErc20sViaCall (same address on BSC + ETH today). */
  relayRouter?: Address;
}): RelayCallTx[] {
  const gateway = args.gateway ?? RZ_GATEWAY;
  const usdt = args.usdt ?? USDT;
  const router = args.relayRouter ?? RELAY_ROUTER;
  const fulfillData = encodeFunctionData({
    abi: RZ_GATEWAY_ABI,
    functionName: "fulfillBuy",
    args: [args.swapId, args.tokenOut, args.minOut, args.path, args.user],
  });
  const cleanupData = encodeFunctionData({
    abi: CLEANUP_VIA_CALL_ABI,
    functionName: "cleanupErc20sViaCall",
    args: [[usdt], [gateway], [fulfillData], [0n]],
  });
  return [{ to: router, value: "0", data: cleanupData }];
}

/**
 * BUY destination calls (ETH): avoid cleanupErc20sViaCall (raw approve breaks on mainnet USDT).
 *   1. router.cleanupErc20s → safeTransfer full USDT to EthUsdtFillAdapter
 *   2. fillAdapter.fill → forceApprove(gateway) + fulfillBuy
 */
export function buildEthBuyTxs(args: {
  swapId: Hex;
  tokenOut: Address;
  minOut: bigint;
  path: Address[];
  user: Address;
  usdt: Address;
  fillAdapter: Address;
  relayRouter?: Address;
}): RelayCallTx[] {
  if (!args.fillAdapter || args.fillAdapter === ZERO) {
    throw new Error("ETH USDT fill adapter is not configured (NEXT_PUBLIC_ETH_USDT_FILL_ADAPTER).");
  }
  const router = args.relayRouter ?? RELAY_ROUTER;
  const cleanupData = encodeFunctionData({
    abi: CLEANUP_ERC20S_ABI,
    functionName: "cleanupErc20s",
    args: [[args.usdt], [args.fillAdapter], [0n], "0x"],
  });
  const fillData = encodeFunctionData({
    abi: ETH_FILL_ADAPTER_ABI,
    functionName: "fill",
    args: [args.swapId, args.tokenOut, args.minOut, args.path, args.user],
  });
  return [
    { to: router, value: "0", data: cleanupData },
    { to: args.fillAdapter, value: "0", data: fillData },
  ];
}

/**
 * SELL `extraData` = abi.encode(depository, refundTo, depositCalldata) consumed by RelayDepositAdapter.
 * depository/depositCalldata come from Relay's /quote; refundTo is the user's BSC address.
 */
export function buildSellExtraData(depository: Address, refundTo: Address, depositCalldata: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "bytes" }],
    [depository, refundTo, depositCalldata],
  );
}
