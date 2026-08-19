import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Execute } from "@reservoir0x/relay-sdk";
import {
  BSC_TOKENS,
  TRON_TOKENS,
  USDT_BSC,
  USDT_TRON_ADDRESS,
  USDT_ETH,
} from "./tokens";

vi.mock("./relay", () => ({
  getRelayQuote: vi.fn(),
  relayOutputAmount: vi.fn(),
  relayMinimumOutput: vi.fn(),
  relayUsd: vi.fn(),
  relayFeeUsd: vi.fn(),
}));

vi.mock("./sushi", () => ({
  getSushiQuote: vi.fn(),
  getSushiSwap: vi.fn(),
  toSushiTokenAddress: vi.fn((a: string) => a),
}));

vi.mock("./kyber", () => ({
  getKyberQuote: vi.fn(),
  getKyberSwap: vi.fn(),
}));

vi.mock("./fly", () => ({
  getFlyQuote: vi.fn(),
  getFlySwap: vi.fn(),
}));

vi.mock("./lifi", () => ({
  getLifiQuote: vi.fn(),
  getLifiSwap: vi.fn(),
}));

import {
  getRelayQuote,
  relayOutputAmount,
  relayMinimumOutput,
  relayUsd,
  relayFeeUsd,
} from "./relay";
import { getSushiQuote } from "./sushi";
import { getKyberQuote } from "./kyber";
import { getFlyQuote } from "./fly";
import { getLifiQuote } from "./lifi";
import { computeBestQuote, canUseSushi, canUseLifi } from "./relayQuote";

const CAR = BSC_TOKENS.find((t) => t.symbol === "CAR")!;
const MGC = BSC_TOKENS.find((t) => t.symbol === "MGC")!;
const USDT_TRON = TRON_TOKENS.find((t) => t.symbol === "USDT")!;
const FAKE_QUOTE = { steps: [] } as Execute;

function mockRelayOut(out: bigint, min?: bigint) {
  vi.mocked(getRelayQuote).mockResolvedValue(FAKE_QUOTE);
  vi.mocked(relayOutputAmount).mockReturnValue(out);
  vi.mocked(relayMinimumOutput).mockReturnValue(min);
  vi.mocked(relayUsd).mockReturnValue({ inUsd: 10, outUsd: 9.5 });
  vi.mocked(relayFeeUsd).mockReturnValue(0.5);
}

beforeEach(() => {
  vi.mocked(getRelayQuote).mockReset();
  vi.mocked(relayOutputAmount).mockReset();
  vi.mocked(relayMinimumOutput).mockReset();
  vi.mocked(relayUsd).mockReset();
  vi.mocked(relayFeeUsd).mockReset();
  vi.mocked(getSushiQuote).mockReset();
  vi.mocked(getKyberQuote).mockReset();
  vi.mocked(getFlyQuote).mockReset();
  vi.mocked(getLifiQuote).mockReset();
});

describe("canUseSushi / canUseLifi", () => {
  it("sushi: same-chain BSC only", () => {
    expect(canUseSushi(MGC, USDT_BSC)).toBe(true);
    expect(canUseSushi(USDT_ETH, USDT_BSC)).toBe(false);
  });
  it("lifi: cross-chain EVM and Tron↔EVM", () => {
    expect(canUseLifi(USDT_ETH, USDT_BSC)).toBe(true);
    expect(canUseLifi(MGC, USDT_BSC)).toBe(false);
    expect(canUseLifi(USDT_TRON, CAR)).toBe(true);
    expect(canUseLifi(MGC, USDT_TRON)).toBe(true);
    expect(canUseLifi(USDT_TRON, USDT_ETH)).toBe(true);
  });
});

describe("computeBestQuote local (Relay vs Sushi vs Kyber vs Fly)", () => {
  it("picks Sushi when highest", async () => {
    mockRelayOut(900_000n, 891_000n);
    vi.mocked(getSushiQuote).mockResolvedValue({ amountOut: 950_000n });
    vi.mocked(getKyberQuote).mockResolvedValue({
      amountOut: 940_000n,
      routeSummary: {},
      routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    });
    vi.mocked(getFlyQuote).mockResolvedValue({ amountOut: 930_000n });
    const result = await computeBestQuote(MGC, USDT_BSC, 1_000_000n, "0xabc", 100);
    expect(result.provider).toBe("sushi");
    expect(getLifiQuote).not.toHaveBeenCalled();
  });

  it("picks Kyber when highest", async () => {
    mockRelayOut(900_000n, 891_000n);
    vi.mocked(getSushiQuote).mockResolvedValue({ amountOut: 950_000n });
    vi.mocked(getKyberQuote).mockResolvedValue({
      amountOut: 980_000n,
      routeSummary: {},
      routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    });
    vi.mocked(getFlyQuote).mockResolvedValue({ amountOut: 970_000n });
    const result = await computeBestQuote(MGC, USDT_BSC, 1_000_000n, "0xabc", 100);
    expect(result.provider).toBe("kyber");
    expect(result.routeLabel).toContain("KyberSwap");
  });

  it("picks Fly when highest", async () => {
    mockRelayOut(900_000n, 891_000n);
    vi.mocked(getSushiQuote).mockResolvedValue({ amountOut: 950_000n });
    vi.mocked(getKyberQuote).mockResolvedValue({
      amountOut: 960_000n,
      routeSummary: {},
      routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    });
    vi.mocked(getFlyQuote).mockResolvedValue({ amountOut: 990_000n });
    const result = await computeBestQuote(MGC, USDT_BSC, 1_000_000n, "0xabc", 100);
    expect(result.provider).toBe("fly");
    expect(result.routeLabel).toContain("Fly");
  });

  it("picks Relay when highest", async () => {
    mockRelayOut(990_000n, 980_000n);
    vi.mocked(getSushiQuote).mockResolvedValue({ amountOut: 950_000n });
    vi.mocked(getKyberQuote).mockResolvedValue({
      amountOut: 960_000n,
      routeSummary: {},
      routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    });
    vi.mocked(getFlyQuote).mockResolvedValue({ amountOut: 970_000n });
    const result = await computeBestQuote(MGC, USDT_BSC, 1n, undefined, 100);
    expect(result.provider).toBe("relay");
  });

  it("falls back when aggregators miss", async () => {
    mockRelayOut(900_000n, 891_000n);
    vi.mocked(getSushiQuote).mockResolvedValue(null);
    vi.mocked(getKyberQuote).mockResolvedValue(null);
    vi.mocked(getFlyQuote).mockResolvedValue(null);
    const result = await computeBestQuote(MGC, USDT_BSC, 1n, undefined, 100);
    expect(result.provider).toBe("relay");
  });
});

describe("computeBestQuote cross-chain (Relay vs LI.FI)", () => {
  it("picks LI.FI when higher", async () => {
    mockRelayOut(90_000_000n, 89_000_000n);
    vi.mocked(getLifiQuote).mockResolvedValue({
      amountOut: 95_000_000n,
      amountOutMin: 94_000_000n,
      bridgeFeeUsd: 0.25,
      tool: "stargate",
    });
    const result = await computeBestQuote(USDT_ETH, USDT_BSC, 100_000_000n, undefined, 50);
    expect(result.provider).toBe("lifi");
    expect(result.output).toBe(95_000_000n);
    expect(result.routeLabel).toContain("LI.FI");
    expect(getSushiQuote).not.toHaveBeenCalled();
  });

  it("picks Relay when higher than LI.FI", async () => {
    mockRelayOut(96_000_000n, 95_000_000n);
    vi.mocked(getLifiQuote).mockResolvedValue({
      amountOut: 95_000_000n,
      amountOutMin: 94_000_000n,
    });
    const result = await computeBestQuote(USDT_ETH, MGC, 100_000_000n, undefined, 50);
    expect(result.provider).toBe("relay");
  });

  it("falls back to Relay when LI.FI has no route", async () => {
    mockRelayOut(90_000_000n, 89_000_000n);
    vi.mocked(getLifiQuote).mockResolvedValue(null);
    const result = await computeBestQuote(USDT_ETH, USDT_BSC, 1n, undefined, 50);
    expect(result.provider).toBe("relay");
  });

  it("races LI.FI for BSC → Tron", async () => {
    mockRelayOut(90_000_000n, 89_000_000n);
    vi.mocked(getLifiQuote).mockResolvedValue({
      amountOut: 95_000_000n,
      amountOutMin: 94_000_000n,
      tool: "near",
    });
    const result = await computeBestQuote(MGC, USDT_TRON, 1_000_000n, "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", 50);
    expect(result.provider).toBe("lifi");
    expect(getLifiQuote).toHaveBeenCalled();
  });

  it("races LI.FI for Tron → BSC", async () => {
    mockRelayOut(90_000_000n, 89_000_000n);
    vi.mocked(getLifiQuote).mockResolvedValue({
      amountOut: 95_000_000n,
      amountOutMin: 94_000_000n,
      tool: "symbiosis",
    });
    const result = await computeBestQuote(USDT_TRON, CAR, 1_000_000n, undefined, 100);
    expect(result.provider).toBe("lifi");
    expect(getRelayQuote).toHaveBeenCalledWith(
      expect.objectContaining({ user: USDT_TRON_ADDRESS }),
    );
  });
});
