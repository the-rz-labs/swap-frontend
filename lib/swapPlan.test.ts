import { describe, it, expect } from "vitest";
import { classify, planSwap } from "./swapPlan";
import {
  BSC_TOKENS,
  REMOTE_TOKENS,
  TRON_TOKENS,
  USDT_BSC,
  USDT_ETH,
  GOLDGR,
  type Token,
} from "./tokens";

const CAR = BSC_TOKENS.find((t) => t.symbol === "CAR")!;
const USDT_TRON = TRON_TOKENS.find((t) => t.symbol === "USDT")!;
const ETH = REMOTE_TOKENS.find((t) => t.symbol === "ETH")!;
const USDC_ETH = REMOTE_TOKENS.find((t) => t.symbol === "USDC")!;

describe("swapPlan with Tron tokens (non-GOLDGR regression)", () => {
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

  it("keeps local BSC CAR ↔ USDT unchanged", () => {
    expect(classify(CAR, USDT_BSC)).toBe("local");
    expect(planSwap(CAR, USDT_BSC).legs.map((l) => l.kind)).toEqual(["rzswap"]);
  });

  it("keeps USDT(ETH) → CAR as inbound (not GOLDGR)", () => {
    expect(classify(USDT_ETH, CAR)).toBe("inbound");
  });
});

describe("swapPlan GOLDGR hub", () => {
  it("classifies USDT(ETH) ↔ GOLDGR as local-eth", () => {
    expect(classify(USDT_ETH, GOLDGR)).toBe("local-eth");
    expect(classify(GOLDGR, USDT_ETH)).toBe("local-eth");
  });

  it("classifies ETH / USDC / Tron / USDT(BSC) → GOLDGR as buy-goldgr", () => {
    expect(classify(ETH, GOLDGR)).toBe("buy-goldgr");
    expect(classify(USDC_ETH, GOLDGR)).toBe("buy-goldgr");
    expect(classify(USDT_TRON, GOLDGR)).toBe("buy-goldgr");
    expect(classify(USDT_BSC, GOLDGR)).toBe("buy-goldgr");
  });

  it("classifies CAR → GOLDGR as bsc-to-goldgr (composed sell)", () => {
    expect(classify(CAR, GOLDGR)).toBe("bsc-to-goldgr");
  });

  it("classifies GOLDGR → CAR / Tron / ETH as sell-goldgr", () => {
    expect(classify(GOLDGR, CAR)).toBe("sell-goldgr");
    expect(classify(GOLDGR, USDT_TRON)).toBe("sell-goldgr");
    expect(classify(GOLDGR, ETH)).toBe("sell-goldgr");
    expect(classify(GOLDGR, USDT_BSC)).toBe("sell-goldgr");
  });

  it("plans local-eth with a single rzswap leg", () => {
    const plan = planSwap(USDT_ETH, GOLDGR);
    expect(plan.kind).toBe("local-eth");
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0].kind).toBe("rzswap");
  });

  it("plans buy-goldgr as a single relay leg", () => {
    const plan = planSwap(ETH, GOLDGR);
    expect(plan.kind).toBe("buy-goldgr");
    expect(plan.legs.map((l) => l.kind)).toEqual(["relay"]);
  });

  it("plans bsc-to-goldgr as rzswap (BSC sell + ETH fulfillBuy)", () => {
    const plan = planSwap(CAR, GOLDGR);
    expect(plan.kind).toBe("bsc-to-goldgr");
    expect(plan.legs[0].kind).toBe("rzswap");
  });

  it("plans GOLDGR → CAR with hubIsEndpoint false (dest fulfillBuy)", () => {
    const plan = planSwap(GOLDGR, CAR);
    expect(plan.kind).toBe("sell-goldgr");
    expect(plan.hubIsEndpoint).toBe(false);
  });

  it("plans GOLDGR → Tron with hubIsEndpoint true", () => {
    const plan = planSwap(GOLDGR, USDT_TRON);
    expect(plan.kind).toBe("sell-goldgr");
    expect(plan.hubIsEndpoint).toBe(true);
  });
});
