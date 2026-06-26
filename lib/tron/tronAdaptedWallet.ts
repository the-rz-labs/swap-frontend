import type { AdaptedWallet } from "@reservoir0x/relay-sdk";
import { TRON_CHAIN_ID } from "../tokens";
import { buildTriggerTx, broadcastTx, waitForTronReceipt, type TronTriggerParameter } from "./tronGrid";
import { getTronSigner } from "./tronDynamic";

/**
 * Pull Relay's TriggerSmartContract parameter out of a Relay execute step item. The raw /quote shape
 * is `{ parameter, type }`; the SDK may also nest it under `.data`. We accept both and require the
 * contract-call fields TronGrid needs to build a transaction.
 */
export function extractTronParam(item: unknown): TronTriggerParameter {
  const d = (item as { data?: unknown })?.data ?? item;
  const node = d as { parameter?: TronTriggerParameter; data?: { parameter?: TronTriggerParameter } };
  const param = node.parameter ?? node.data?.parameter;
  if (!param?.owner_address || !param?.contract_address || !param?.data) {
    throw new Error("Unexpected Tron step shape from Relay (no TriggerSmartContract parameter).");
  }
  return param;
}

/**
 * Builds a Relay {@link AdaptedWallet} (vmType "tvm") backed by a connected WalletConnect Tron session.
 * Each Relay source step is a TriggerSmartContract: we build the unsigned tx (TronGrid), have the
 * wallet sign it (WalletConnect), broadcast it (TronGrid), and confirm it. This is what lets a
 * USDT-on-Tron buy be signed on the user's phone, exactly like relay.link/bridge.
 */
export function tronAdaptedWallet(address: string): AdaptedWallet {
  return {
    vmType: "tvm",
    getChainId: async () => TRON_CHAIN_ID,
    address: async () => address,
    switchChain: async () => {}, // single Tron chain; nothing to switch
    handleSignMessageStep: async () => {
      throw new Error("Tron message signing is not used by this flow.");
    },
    handleSendTransactionStep: async (_chainId, item) => {
      const signer = getTronSigner();
      if (!signer) throw new Error("No Tron wallet connected to sign the source transaction.");
      const param = extractTronParam(item);
      const unsigned = await buildTriggerTx(param);
      const signed = await signer.sign(unsigned);
      return broadcastTx(signed);
    },
    // Relay's receipt types are EVM/SVM/Sui-shaped; Tron has none, so we confirm via TronGrid and
    // return a minimal receipt-like object (the executor only checks for resolution, not its fields).
    handleConfirmTransactionStep: async (txid: string) => {
      await waitForTronReceipt(txid);
      return { txHash: txid, blockHash: txid, blockNumber: 0 } as unknown as Awaited<
        ReturnType<AdaptedWallet["handleConfirmTransactionStep"]>
      >;
    },
  };
}
