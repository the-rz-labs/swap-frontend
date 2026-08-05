import { describe, it, expect } from "vitest";
import type { Execute } from "@reservoir0x/relay-sdk";
import { encodeFunctionData } from "viem";
import {
  relayOutAmounts,
  DEST_FILL_PLACEHOLDER_MIN_OUT,
  buildDestFillProbeTxs,
  buildEthDestFillProbeTxs,
} from "./relayDestFill";
import { applySlippage } from "./swapPlan";
import { RZ_GATEWAY_ABI } from "./gateway";

function fakeRelayQuote(amount: string, minimumAmount: string): Execute {
  return {
    details: {
      currencyOut: { amount, minimumAmount },
    },
  } as Execute;
}

describe("relayOutAmounts", () => {
  it("reads expected and minimum (fee-aware) from a Relay quote", () => {
    const q = fakeRelayQuote("700000", "500000");
    const { expected, minimum } = relayOutAmounts(q);
    expect(expected).toBe(700000n);
    expect(minimum).toBe(500000n);
  });

  it("falls back minimum → expected when minimumAmount missing", () => {
    const q = {
      details: { currencyOut: { amount: "700000" } },
    } as Execute;
    expect(relayOutAmounts(q).minimum).toBe(700000n);
  });

  it("models fulfillBuy floor as slip(treasury(relayMin))", () => {
    const goldFromMin = 4_000_000_000_000_000n;
    const minOut = applySlippage(goldFromMin, 100);
    expect(minOut).toBe((goldFromMin * 9900n) / 10_000n);
  });

  it("adds dest price buffer on top of user slip", async () => {
    const { destTreasurySlippageBps, DEST_PRICE_BUFFER_BPS } = await import("./relayDestFill");
    expect(destTreasurySlippageBps(100)).toBe(100 + DEST_PRICE_BUFFER_BPS);
  });
});

describe("buildDestFillProbeTxs", () => {
  it("encodes fulfillBuy with placeholder minOut=1 for fee probing", () => {
    expect(DEST_FILL_PLACEHOLDER_MIN_OUT).toBe(1n);
    const user = "0x5903D3219820E51453A28dB045e46659eBd8279A" as const;
    const tokenOut = "0x957E0fDfbd1c2F97648318B2f057E327996EC367" as const;
    const path = [
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      tokenOut,
    ] as const;
    const txs = buildDestFillProbeTxs({
      swapId: ("0x" + "11".repeat(32)) as `0x${string}`,
      tokenOut,
      path: [...path],
      user,
      gateway: "0xd2471055174319f30A441c856e6E5577f4a852B0",
      usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    });
    expect(txs).toHaveLength(1);
    const expectedFulfill = encodeFunctionData({
      abi: RZ_GATEWAY_ABI,
      functionName: "fulfillBuy",
      args: [("0x" + "11".repeat(32)) as `0x${string}`, tokenOut, 1n, [...path], user],
    });
    expect(txs[0]!.data.toLowerCase()).toContain(expectedFulfill.slice(2).toLowerCase());
  });
});

describe("buildEthDestFillProbeTxs", () => {
  it("emits cleanupErc20s + fill (two txs) with placeholder minOut", () => {
    const user = "0x5903D3219820E51453A28dB045e46659eBd8279A" as const;
    const tokenOut = "0x957E0fDfbd1c2F97648318B2f057E327996EC367" as const;
    const fillAdapter = "0x1111111111111111111111111111111111111111" as const;
    const path = [
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      tokenOut,
    ] as const;
    const txs = buildEthDestFillProbeTxs({
      swapId: ("0x" + "22".repeat(32)) as `0x${string}`,
      tokenOut,
      path: [...path],
      user,
      usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      fillAdapter,
    });
    expect(txs).toHaveLength(2);
    expect(txs[0]!.data.toLowerCase().startsWith("0x9bb43718")).toBe(true); // cleanupErc20s(,,,bytes)
    expect(txs[1]!.to.toLowerCase()).toBe(fillAdapter.toLowerCase());
    expect(txs[1]!.data.toLowerCase()).toContain("0000000000000000000000000000000000000000000000000000000000000001"); // minOut=1
  });
});
