import { describe, it, expect } from "vitest";
import { toKyberTokenAddress, KYBER_NATIVE, kyberChainSlug } from "./kyber";
import { NATIVE_ADDRESS } from "./tokens";

describe("kyber helpers", () => {
  it("maps zero address to Kyber native sentinel", () => {
    expect(toKyberTokenAddress(NATIVE_ADDRESS)).toBe(KYBER_NATIVE);
  });

  it("checksums ERC20 addresses", () => {
    expect(toKyberTokenAddress("0x55d398326f99059ff775485246999027b3197955")).toBe(
      "0x55d398326f99059fF775485246999027B3197955",
    );
  });

  it("supports BSC and Ethereum slugs", () => {
    expect(kyberChainSlug(56)).toBe("bsc");
    expect(kyberChainSlug(1)).toBe("ethereum");
    expect(kyberChainSlug(728126428)).toBeUndefined();
  });
});
