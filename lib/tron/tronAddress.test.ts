import { describe, it, expect } from "vitest";
import { isTronAddress, tronBase58ToHex, tronHexToBase58 } from "./tronAddress";

// Known Tron vectors:
//  - USDT-TRC20 contract
//  - Relay's native-TRX marker (the Tron "zero" address)
const USDT_B58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_HEX = "0x41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
const TRX_B58 = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const TRX_HEX = "0x410000000000000000000000000000000000000000";

describe("tron address codec", () => {
  it("decodes base58 -> 0x41 hex", () => {
    expect(tronBase58ToHex(USDT_B58)).toBe(USDT_HEX);
    expect(tronBase58ToHex(TRX_B58)).toBe(TRX_HEX);
  });

  it("encodes 0x41 hex -> base58", () => {
    expect(tronHexToBase58(USDT_HEX)).toBe(USDT_B58);
    expect(tronHexToBase58(TRX_HEX)).toBe(TRX_B58);
  });

  it("round-trips", () => {
    expect(tronHexToBase58(tronBase58ToHex(USDT_B58))).toBe(USDT_B58);
  });

  it("accepts valid Tron addresses", () => {
    expect(isTronAddress(USDT_B58)).toBe(true);
    expect(isTronAddress(TRX_B58)).toBe(true);
  });

  it("rejects non-Tron / malformed input", () => {
    expect(isTronAddress("0x55d398326f99059fF775485246999027B3197955")).toBe(false); // EVM
    expect(isTronAddress("")).toBe(false);
    expect(isTronAddress("Tnot-a-real-address")).toBe(false);
    // valid base58 length but corrupted checksum (flip last char)
    expect(isTronAddress(USDT_B58.slice(0, -1) + (USDT_B58.endsWith("t") ? "u" : "t"))).toBe(false);
  });
});
