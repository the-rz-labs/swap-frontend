/**
 * Minimal Tron full-node (TronGrid) HTTP client — just what the buy-from-Tron flow needs:
 * build an unsigned transaction from Relay's TriggerSmartContract step, and broadcast a signed one.
 * No TronWeb dependency: Relay hands us the raw contract call, TronGrid turns it into a transaction,
 * the wallet signs it over WalletConnect, and we broadcast it back.
 */
import { tronBase58ToHex } from "./tronAddress";

const TRON_RPC = process.env.NEXT_PUBLIC_TRON_RPC || "https://api.trongrid.io";

/** Default fee ceiling (in SUN, 1 TRX = 1e6 SUN) for a source tx. USDT transfers + a fresh-account
 *  activation can be costly on Tron; the user's wallet shows and caps the actual spend. */
const DEFAULT_FEE_LIMIT = 150_000_000; // 150 TRX

/** The contract-call parameter Relay returns for a Tron step (hex 0x41 addresses, raw calldata). */
export type TronTriggerParameter = {
  owner_address: string;
  contract_address: string;
  call_value?: number;
  data: string;
};

/** A Tron transaction (unsigned, or signed once `signature` is present). */
export type TronTransaction = {
  txID: string;
  raw_data: unknown;
  raw_data_hex: string;
  visible?: boolean;
  signature?: string[];
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${TRON_RPC}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`TronGrid ${path} failed: ${res.status}`);
  return json as T;
}

/**
 * Wrap Relay's TriggerSmartContract parameter into a full unsigned Tron transaction (adds ref block,
 * expiration, fee limit). This is what the wallet signs.
 */
export async function buildTriggerTx(
  param: TronTriggerParameter,
  feeLimit = DEFAULT_FEE_LIMIT,
): Promise<TronTransaction> {
  const out = await post<{ result?: { result?: boolean; message?: string }; transaction?: TronTransaction }>(
    "/wallet/triggersmartcontract",
    {
      owner_address: param.owner_address,
      contract_address: param.contract_address,
      data: param.data,
      call_value: param.call_value ?? 0,
      fee_limit: feeLimit,
      visible: false,
    },
  );
  if (!out.transaction) {
    const msg = out.result?.message ? Buffer.from(out.result.message, "hex").toString() : "no transaction returned";
    throw new Error(`Tron triggersmartcontract failed: ${msg}`);
  }
  return out.transaction;
}

/** Broadcast a signed Tron transaction; returns its txid on success. */
export async function broadcastTx(signed: TronTransaction): Promise<string> {
  const out = await post<{ result?: boolean; txid?: string; code?: string; message?: string }>(
    "/wallet/broadcasttransaction",
    signed,
  );
  if (!out.result) {
    const msg = out.message ? Buffer.from(out.message, "hex").toString() : out.code || "broadcast rejected";
    throw new Error(`Tron broadcast failed: ${msg}`);
  }
  return out.txid ?? signed.txID;
}

/** Read a TRC-20 token balance (e.g. USDT) for a Tron owner via a constant `balanceOf` call. */
export async function getTrc20Balance(ownerBase58: string, tokenBase58: string): Promise<bigint> {
  const ownerHex = tronBase58ToHex(ownerBase58).slice(2); // "41" + 20-byte account
  const tokenHex = tronBase58ToHex(tokenBase58).slice(2);
  const parameter = "0".repeat(24) + ownerHex.slice(2); // 20-byte address left-padded to 32 bytes
  const out = await post<{ constant_result?: string[] }>("/wallet/triggerconstantcontract", {
    owner_address: ownerHex,
    contract_address: tokenHex,
    function_selector: "balanceOf(address)",
    parameter,
    visible: false,
  });
  const hex = out.constant_result?.[0];
  return hex ? BigInt("0x" + hex) : 0n;
}

/** Read TRC-20 `allowance(owner, spender)`. */
export async function getTrc20Allowance(
  ownerBase58: string,
  tokenBase58: string,
  spenderBase58: string,
): Promise<bigint> {
  const ownerHex = tronBase58ToHex(ownerBase58).slice(2);
  const tokenHex = tronBase58ToHex(tokenBase58).slice(2);
  const spenderHex = tronBase58ToHex(spenderBase58).slice(2);
  const parameter = "0".repeat(24) + ownerHex.slice(2) + "0".repeat(24) + spenderHex.slice(2);
  const out = await post<{ constant_result?: string[] }>("/wallet/triggerconstantcontract", {
    owner_address: ownerHex,
    contract_address: tokenHex,
    function_selector: "allowance(address,address)",
    parameter,
    visible: false,
  });
  const hex = out.constant_result?.[0];
  return hex ? BigInt("0x" + hex) : 0n;
}

/** ABI-encode `approve(address,uint256)` for a Tron spender (base58). */
export function encodeTrc20Approve(spenderBase58: string, amount: bigint): string {
  const spenderHex = tronBase58ToHex(spenderBase58).slice(2); // 41 + 20 bytes
  const addr20 = spenderHex.slice(2);
  const amountHex = amount.toString(16).padStart(64, "0");
  return "095ea7b3" + "0".repeat(24) + addr20 + amountHex;
}

/**
 * Build + sign + broadcast a TriggerSmartContract call.
 * Addresses may be base58 or `0x41…` hex; calldata may include a `0x` prefix.
 */
export async function sendTronContractCall(input: {
  ownerBase58: string;
  contractBase58: string;
  data: string;
  callValue?: number;
  feeLimit?: number;
  sign: (tx: TronTransaction) => Promise<TronTransaction>;
}): Promise<string> {
  const owner_address = tronBase58ToHex(input.ownerBase58).slice(2);
  const contract_address = tronBase58ToHex(input.contractBase58).slice(2);
  const data = input.data.startsWith("0x") ? input.data.slice(2) : input.data;
  const unsigned = await buildTriggerTx(
    {
      owner_address,
      contract_address,
      data,
      call_value: input.callValue ?? 0,
    },
    input.feeLimit ?? DEFAULT_FEE_LIMIT,
  );
  const signed = await input.sign(unsigned);
  return broadcastTx(signed);
}

/** Approve `spender` for `amount` on a TRC-20 if allowance is insufficient. */
export async function ensureTrc20Allowance(input: {
  ownerBase58: string;
  tokenBase58: string;
  spenderBase58: string;
  amount: bigint;
  sign: (tx: TronTransaction) => Promise<TronTransaction>;
}): Promise<void> {
  const allowance = await getTrc20Allowance(input.ownerBase58, input.tokenBase58, input.spenderBase58);
  if (allowance >= input.amount) return;
  const txid = await sendTronContractCall({
    ownerBase58: input.ownerBase58,
    contractBase58: input.tokenBase58,
    data: encodeTrc20Approve(input.spenderBase58, 2n ** 256n - 1n),
    sign: input.sign,
  });
  await waitForTronReceipt(txid);
}

/** Poll a Tron tx until it has a result; resolves true if it executed SUCCESS. */
export async function waitForTronReceipt(txid: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await post<{ receipt?: { result?: string }; id?: string }>("/wallet/gettransactioninfobyid", {
      value: txid,
    });
    if (info?.id) return info.receipt?.result === "SUCCESS" || info.receipt?.result == null;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Tron transaction not confirmed in time");
}
