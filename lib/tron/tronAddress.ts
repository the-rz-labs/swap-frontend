import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha256";

// Tron addresses are base58check over a 21-byte payload: a 0x41 version byte + the 20-byte account.
// base58check = base58( payload || sha256(sha256(payload))[0..4] ).
const TRON_PREFIX = 0x41;

function doubleSha256First4(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes)).slice(0, 4);
}

function decodeChecked(addr: string): Uint8Array | null {
  let raw: Uint8Array;
  try {
    raw = bs58.decode(addr);
  } catch {
    return null;
  }
  if (raw.length !== 25) return null; // 21 payload + 4 checksum
  const payload = raw.slice(0, 21);
  const checksum = raw.slice(21);
  if (payload[0] !== TRON_PREFIX) return null;
  const expected = doubleSha256First4(payload);
  for (let i = 0; i < 4; i++) if (checksum[i] !== expected[i]) return null;
  return payload;
}

/** True if `s` is a valid base58check Tron address (T-prefixed, 0x41 version, good checksum). */
export function isTronAddress(s: string): boolean {
  return typeof s === "string" && s.startsWith("T") && decodeChecked(s) !== null;
}

/** Base58 Tron address → 21-byte `0x41…` hex. Throws on an invalid address. */
export function tronBase58ToHex(addr: string): string {
  const payload = decodeChecked(addr);
  if (!payload) throw new Error(`Invalid Tron address: ${addr}`);
  return "0x" + Buffer.from(payload).toString("hex");
}

/** 21-byte `0x41…` hex (or 20-byte hex, assumed 0x41-prefixed account) → base58 Tron address. */
export function tronHexToBase58(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  let payload = Buffer.from(clean, "hex");
  if (payload.length === 20) payload = Buffer.concat([Buffer.from([TRON_PREFIX]), payload]);
  if (payload.length !== 21 || payload[0] !== TRON_PREFIX) {
    throw new Error(`Invalid Tron hex address: ${hex}`);
  }
  const checksum = doubleSha256First4(payload);
  return bs58.encode(Buffer.concat([payload, checksum]));
}
