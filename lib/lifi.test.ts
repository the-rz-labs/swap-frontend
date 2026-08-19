import { describe, it, expect, vi, beforeEach } from "vitest";
import { getLifiQuote } from "./lifi";

describe("getLifiQuote", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses toAmount / toAmountMin and feeCosts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        tool: "stargate",
        estimate: {
          toAmount: "1000000",
          toAmountMin: "990000",
          feeCosts: [
            { name: "LIFI Fixed Fee", amountUSD: "0.25", included: true },
            { name: "Gas receiver fee", amountUSD: "0.10", included: false },
          ],
        },
        transactionRequest: {
          to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
          data: "0xdead",
          value: "0x0",
          chainId: 1,
        },
      }),
    } as Response);

    const q = await getLifiQuote({
      fromChainId: 1,
      toChainId: 56,
      fromToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      toToken: "0x55d398326f99059fF775485246999027B3197955",
      amount: 100_000_000n,
      slippageBps: 50,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(q).toEqual({
      amountOut: 1_000_000n,
      amountOutMin: 990_000n,
      bridgeFeeUsd: 0.1,
      serviceFeeUsd: 0.25,
      tool: "stargate",
      tx: expect.objectContaining({
        to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
        data: "0xdead",
      }),
    });
  });

  it("returns null when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const q = await getLifiQuote({
      fromChainId: 1,
      toChainId: 56,
      fromToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      toToken: "0x55d398326f99059fF775485246999027B3197955",
      amount: 1n,
      slippageBps: 50,
    });
    expect(q).toBeNull();
  });
});
