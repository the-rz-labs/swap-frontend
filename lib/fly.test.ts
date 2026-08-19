import { describe, it, expect } from "vitest";
import { toFlyTokenAddress, flyNetwork, FLY_NATIVE } from "./fly";
import { NATIVE_ADDRESS } from "./tokens";

describe("fly helpers", () => {
  it("keeps zero address as Fly native", () => {
    expect(toFlyTokenAddress(NATIVE_ADDRESS)).toBe(FLY_NATIVE);
  });

  it("maps eeee sentinel to Fly native zero address", () => {
    expect(toFlyTokenAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE")).toBe(FLY_NATIVE);
  });

  it("checksums ERC20 addresses", () => {
    expect(toFlyTokenAddress("0x55d398326f99059ff775485246999027b3197955")).toBe(
      "0x55d398326f99059fF775485246999027B3197955",
    );
  });

  it("supports BSC and Ethereum networks", () => {
    expect(flyNetwork(56)).toBe("bsc");
    expect(flyNetwork(1)).toBe("ethereum");
    expect(flyNetwork(728126428)).toBeUndefined();
  });
});
