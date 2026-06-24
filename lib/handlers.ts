/**
 * Integration glue for the cross-chain handlers (new treasury+Relay architecture).
 *
 *  - BUY  (any chain -> BSC token): a Relay quote whose `recipient` is the BridgeSwapHandler and
 *    whose destination `txs` is a single `fulfill(...)` call. Relay delivers USDT to the handler and
 *    runs fulfill, which swaps it to the token (or refunds USDT on failure). ONE user signature.
 *  - SELL (BSC token -> USDT on ETH/Tron): one BSC tx to SellHandler.sellCrossChain, which swaps
 *    token->USDT via RzSwap then executes Relay's deposit calldata via RelayDepositAdapter.
 *
 * See docs/RELAY_INTEGRATION.md (repo root) for the full flow + Relay API specifics.
 */
import { type Address, type Hex, encodeFunctionData, encodeAbiParameters } from "viem";
import { USDT_BSC, BSC_CHAIN_ID } from "./tokens";
import type { RelayCallTx } from "./relay";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const USDT_BSC_ADDRESS = USDT_BSC.address as Address;

export const BRIDGE_SWAP_HANDLER = (process.env.NEXT_PUBLIC_BRIDGE_SWAP_HANDLER ?? ZERO) as Address;
export const SELL_HANDLER = (process.env.NEXT_PUBLIC_SELL_HANDLER ?? ZERO) as Address;
export const RELAY_DEPOSIT_ADAPTER = (process.env.NEXT_PUBLIC_RELAY_DEPOSIT_ADAPTER ?? ZERO) as Address;

export const HANDLERS_CONFIGURED =
  BRIDGE_SWAP_HANDLER !== ZERO && SELL_HANDLER !== ZERO && RELAY_DEPOSIT_ADAPTER !== ZERO;

export const BRIDGE_SWAP_HANDLER_ABI = [
  {
    type: "function",
    name: "fulfill",
    stateMutability: "nonpayable",
    inputs: [
      { name: "swapId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "minAmountOut", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const SELL_HANDLER_ABI = [
  {
    type: "function",
    name: "sellCrossChain",
    stateMutability: "payable",
    inputs: [
      { name: "swapId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "stable", type: "address" },
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

/** Random 32-byte swapId for backend reconciliation (echoed in the contract events). */
export function generateSwapId(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
}

/**
 * BUY: the Relay destination call. Use with a Relay quote where
 *   destinationChainId = 56, destinationCurrency = USDT_BSC, recipient = BRIDGE_SWAP_HANDLER,
 *   txs = [buildBuyFulfillTx(...)].
 * `minAmountOut` should be derived from RzSwap.getOutputAmount(expectedUsdt, path) minus tolerance.
 */
export function buildBuyFulfillTx(args: {
  swapId: Hex;
  tokenOut: Address;
  minAmountOut: bigint;
  path: Address[];
  user: Address;
}): RelayCallTx {
  const data = encodeFunctionData({
    abi: BRIDGE_SWAP_HANDLER_ABI,
    functionName: "fulfill",
    args: [args.swapId, USDT_BSC_ADDRESS, args.tokenOut, args.minAmountOut, args.path, args.user],
  });
  return { to: BRIDGE_SWAP_HANDLER, value: "0", data };
}

/**
 * SELL: build the single BSC transaction (to SellHandler) the user signs.
 * `extraData` = abi.encode(depository, refundTo, depositCalldata) is produced from Relay's /quote
 * for `stable` (USDT) on `dstChainId` -> `recipient`; see buildSellExtraData in lib/relay helpers.
 */
export function buildSellCrossChainTx(args: {
  swapId: Hex;
  tokenIn: Address;
  amountIn: bigint;
  minStableOut: bigint;
  path: Address[];
  dstChainId: number;
  recipient: Hex; // bytes-encoded destination address (EVM 20-byte or Tron)
  extraData: Hex;
  bridgeFeeWei?: bigint;
}): { to: Address; data: Hex; value: bigint } {
  const data = encodeFunctionData({
    abi: SELL_HANDLER_ABI,
    functionName: "sellCrossChain",
    args: [
      args.swapId,
      args.tokenIn,
      args.amountIn,
      USDT_BSC_ADDRESS,
      args.minStableOut,
      args.path,
      RELAY_DEPOSIT_ADAPTER,
      BigInt(args.dstChainId),
      args.recipient,
      args.extraData,
    ],
  });
  return { to: SELL_HANDLER, data, value: args.bridgeFeeWei ?? 0n };
}

export const BUY_DESTINATION_CHAIN = BSC_CHAIN_ID;

/**
 * Encodes the SellHandler `extraData` = abi.encode(depository, refundTo, depositCalldata) consumed
 * by RelayDepositAdapter. `depository`/`depositCalldata` come from getRelaySellDeposit; `refundTo`
 * is the user's BSC address (receives any small drift between the swap output and the bridged amount).
 */
export function buildSellExtraData(depository: Address, refundTo: Address, depositCalldata: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "bytes" }],
    [depository, refundTo, depositCalldata],
  );
}
