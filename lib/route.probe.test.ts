import { describe, it, expect } from "vitest";
import { BSC_USDT_PATH_PROBE } from "./route";
import { BSC_TOKENS } from "./tokens";

describe("BSC path probe", () => {
  it("uses 1 whole USDT (not 1 wei) so unit-price PricingSystem can quote", () => {
    expect(BSC_USDT_PATH_PROBE).toBe(10n ** 18n);
  });

  it("MGC is 9 decimals on-chain", () => {
    const mgc = BSC_TOKENS.find((t) => t.symbol === "MGC");
    expect(mgc?.decimals).toBe(9);
  });
});
