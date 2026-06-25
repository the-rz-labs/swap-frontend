/**
 * RzGateway — the single contract the frontend uses for ALL swaps (local / buy / sell).
 *
 *  - LOCAL : RzGateway.swapLocal(...)                          (1 approve + 1 call)
 *  - BUY   : a Relay order whose destination call is the router's cleanupErc20sViaCall, which
 *            APPROVES the gateway for the full bridged USDT and calls fulfillBuy (allowance-pull).
 *  - SELL  : RzGateway.sell(...) — swaps token->USDT via the engine then bridges out via the adapter.
 *
 * See docs/DESIGN.md for the verified Relay delivery model (approve-then-call, not transfer).
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
/// `token` balance, then calls `to` with `data`. Used to fund + invoke fulfillBuy in one router op.
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

// ── helpers ──────────────────────────────────────────────────────────────────

/** Random 32-byte swapId for backend reconciliation (echoed in SwapExecuted). */
export function generateSwapId(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
}

/**
 * BUY destination call: instruct Relay's router to approve the gateway for the full delivered USDT
 * and call fulfillBuy (allowance-pull). Use as the `txs` of a Relay quote where
 *   destinationChainId = 56, destinationCurrency = USDT, recipient = RELAY_ROUTER.
 * `minOut` should come from RzSwap.getOutputAmount(bridgedMin, path) minus slippage tolerance.
 */
export function buildBuyTxs(args: {
  swapId: Hex;
  tokenOut: Address;
  minOut: bigint;
  path: Address[];
  user: Address;
}): RelayCallTx[] {
  const fulfillData = encodeFunctionData({
    abi: RZ_GATEWAY_ABI,
    functionName: "fulfillBuy",
    args: [args.swapId, args.tokenOut, args.minOut, args.path, args.user],
  });
  const cleanupData = encodeFunctionData({
    abi: CLEANUP_VIA_CALL_ABI,
    functionName: "cleanupErc20sViaCall",
    args: [[USDT], [RZ_GATEWAY], [fulfillData], [0n]],
  });
  return [{ to: RELAY_ROUTER, value: "0", data: cleanupData }];
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
