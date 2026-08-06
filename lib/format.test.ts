import { describe, it, expect } from "vitest";
import { formatAmount } from "./format";
import { BSC_TOKENS, canonicalToken } from "./tokens";

describe("formatAmount", () => {
  it("formats MGC (9 decimals) treasury amounts instead of showing 0", () => {
    // ~0.133 MGC from ~$0.36 USDT→MGC
    expect(formatAmount(133_104_099n, 9)).toBe("0.133104");
  });

  it("does not render non-zero dust as 0 when maxFractionDigits would truncate", () => {
    expect(formatAmount(100n, 9, 6)).toBe("0.0000001");
  });
});

describe("canonicalToken", () => {
  it("refreshes stale MGC decimals from ALL_TOKENS", () => {
    const stale = { ...BSC_TOKENS.find((t) => t.symbol === "MGC")!, decimals: 18 };
    expect(canonicalToken(stale).decimals).toBe(9);
  });
});
