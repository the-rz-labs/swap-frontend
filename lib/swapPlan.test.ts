import { describe, it, expect } from "vitest";
import { classify, planSwap } from "./swapPlan";
import { BSC_TOKENS, REMOTE_TOKENS, TRON_TOKENS, USDT_BSC, type Token } from "./tokens";

const CAR = BSC_TOKENS.find((t) => t.symbol === "CAR")!;
const USDT_TRON = TRON_TOKENS.find((t) => t.symbol === "USDT")!;
const ETH = REMOTE_TOKENS.find((t) => t.symbol === "ETH")!;

describe("swapPlan with Tron tokens", () => {
  it("classifies BSC -> Tron as outbound (sell)", () => {
    expect(classify(CAR, USDT_TRON)).toBe("outbound");
  });

  it("classifies Tron -> BSC as inbound (buy)", () => {
    expect(classify(USDT_TRON, CAR)).toBe("inbound");
  });

  it("rejects remote <-> remote (neither side is BSC)", () => {
    expect(classify(USDT_TRON, ETH)).toBe("invalid");
  });

  it("builds an outbound plan (RzSwap + Relay) for BSC token -> Tron", () => {
    const plan = planSwap(CAR, USDT_TRON);
    expect(plan.kind).toBe("outbound");
    expect(plan.legs.map((l) => l.kind)).toEqual(["rzswap", "relay"]);
  });

  it("treats USDT(BSC) -> Tron as a pure bridge (hub is endpoint)", () => {
    const plan = planSwap(USDT_BSC as Token, USDT_TRON);
    expect(plan.kind).toBe("outbound");
    expect(plan.hubIsEndpoint).toBe(true);
  });
});
