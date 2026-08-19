import { describe, it, expect } from "vitest";
import { classify, planSwap, applySlippage } from "./swapPlan";
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
const MGC = BSC_TOKENS.find((t) => t.symbol === "MGC")!;
const USDT_TRON = TRON_TOKENS.find((t) => t.symbol === "USDT")!;
const ETH = REMOTE_TOKENS.find((t) => t.symbol === "ETH")!;
const USDC_ETH = REMOTE_TOKENS.find((t) => t.symbol === "USDC")!;

describe("classify (relay-only)", () => {
  it("returns invalid for same token", () => {
    expect(classify(CAR, CAR)).toBe("invalid");
    expect(classify(USDT_BSC, USDT_BSC)).toBe("invalid");
    expect(classify(GOLDGR, GOLDGR)).toBe("invalid");
  });

  it("returns relay when tokens differ (BSC local)", () => {
    expect(classify(CAR, USDT_BSC)).toBe("relay");
    expect(classify(MGC, CAR)).toBe("relay");
  });

  it("returns relay for cross-chain pairs", () => {
    expect(classify(CAR, USDT_TRON)).toBe("relay");
    expect(classify(USDT_TRON, CAR)).toBe("relay");
    expect(classify(USDT_ETH, CAR)).toBe("relay");
    expect(classify(ETH, CAR)).toBe("relay");
  });

  it("returns relay for remote-to-remote pairs", () => {
    expect(classify(USDT_TRON, ETH)).toBe("relay");
    expect(classify(ETH, USDC_ETH)).toBe("relay");
  });

  it("returns relay for GOLDGR pairs", () => {
    expect(classify(USDT_ETH, GOLDGR)).toBe("relay");
    expect(classify(GOLDGR, USDT_ETH)).toBe("relay");
    expect(classify(ETH, GOLDGR)).toBe("relay");
    expect(classify(CAR, GOLDGR)).toBe("relay");
    expect(classify(GOLDGR, CAR)).toBe("relay");
    expect(classify(GOLDGR, USDT_TRON)).toBe("relay");
  });
});

describe("planSwap (relay-only)", () => {
  it("returns invalid plan for same token", () => {
    const plan = planSwap(CAR, CAR);
    expect(plan.kind).toBe("invalid");
    expect(plan.legs).toEqual([]);
    expect(plan.error).toBe("Choose two different tokens.");
  });

  it("plans one relay leg for BSC → BSC different tokens", () => {
    const plan = planSwap(CAR, USDT_BSC);
    expect(plan.kind).toBe("relay");
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0].kind).toBe("relay");
    expect(plan.legs.every((l) => l.kind === "relay")).toBe(true);
  });

  it("plans one relay leg for cross-chain BSC → Tron", () => {
    const plan = planSwap(CAR, USDT_TRON);
    expect(plan.kind).toBe("relay");
    expect(plan.legs.map((l) => l.kind)).toEqual(["relay"]);
  });

  it("plans one relay leg for cross-chain Tron → BSC", () => {
    const plan = planSwap(USDT_TRON, CAR);
    expect(plan.kind).toBe("relay");
    expect(plan.legs.map((l) => l.kind)).toEqual(["relay"]);
  });

  it("plans one relay leg for remote → remote", () => {
    const plan = planSwap(USDT_TRON, ETH);
    expect(plan.kind).toBe("relay");
    expect(plan.legs.map((l) => l.kind)).toEqual(["relay"]);
  });

  it("plans one relay leg for USDT(BSC) → Tron (pure bridge via Relay)", () => {
    const plan = planSwap(USDT_BSC as Token, USDT_TRON);
    expect(plan.kind).toBe("relay");
    expect(plan.legs.map((l) => l.kind)).toEqual(["relay"]);
  });

  it("plans one relay leg for GOLDGR local-eth style pair", () => {
    const plan = planSwap(USDT_ETH, GOLDGR);
    expect(plan.kind).toBe("relay");
    expect(plan.legs.map((l) => l.kind)).toEqual(["relay"]);
  });

  it("plans one relay leg for GOLDGR buy (ETH → GOLDGR)", () => {
    const plan = planSwap(ETH, GOLDGR);
    expect(plan.kind).toBe("relay");
    expect(plan.legs.map((l) => l.kind)).toEqual(["relay"]);
  });

  it("plans one relay leg for GOLDGR sell (GOLDGR → CAR)", () => {
    const plan = planSwap(GOLDGR, CAR);
    expect(plan.kind).toBe("relay");
    expect(plan.legs.map((l) => l.kind)).toEqual(["relay"]);
  });

  it("plans one relay leg for BSC token → GOLDGR", () => {
    const plan = planSwap(CAR, GOLDGR);
    expect(plan.kind).toBe("relay");
    expect(plan.legs.map((l) => l.kind)).toEqual(["relay"]);
  });
});

describe("applySlippage", () => {
  it("floors output by slippage bps", () => {
    expect(applySlippage(10_000n, 100)).toBe(9_900n);
    expect(applySlippage(1_000_000n, 50)).toBe(995_000n);
  });
});
