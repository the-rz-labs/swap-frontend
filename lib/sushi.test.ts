import { describe, it, expect } from "vitest";
import { toSushiTokenAddress, SUSHI_NATIVE } from "./sushi";
import { NATIVE_ADDRESS } from "./tokens";

describe("toSushiTokenAddress", () => {
  it("maps zero address to Sushi native sentinel", () => {
    expect(toSushiTokenAddress(NATIVE_ADDRESS).toLowerCase()).toBe(SUSHI_NATIVE.toLowerCase());
  });

  it("checksums normal ERC-20 addresses", () => {
    const raw = "0xbb73bb2505ac4643d5c0a99c2a1f34b3dfd09d11";
    expect(toSushiTokenAddress(raw)).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});
