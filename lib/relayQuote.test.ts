import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Execute } from "@reservoir0x/relay-sdk";
import {
  BSC_TOKENS,
  TRON_TOKENS,
  USDT_BSC,
  USDT_TRON_ADDRESS,
  GOLDGR,
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

import {
  getRelayQuote,
  relayOutputAmount,
  relayMinimumOutput,
  relayUsd,
  relayFeeUsd,
} from "./relay";
import { getSushiQuote } from "./sushi";
import { computeBestQuote, computeRelayOnlyQuote, canUseSushi } from "./relayQuote";

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
});

describe("canUseSushi", () => {
  it("allows same-chain BSC EVM pairs", () => {
    expect(canUseSushi(MGC, USDT_BSC)).toBe(true);
  });
  it("rejects cross-chain and Tron", () => {
    expect(canUseSushi(MGC, GOLDGR)).toBe(false);
    expect(canUseSushi(USDT_TRON, CAR)).toBe(false);
  });
});

describe("computeBestQuote", () => {
  it("rejects same-token pairs", async () => {
    await expect(computeBestQuote(CAR, CAR, 1_000n, undefined, 100)).rejects.toThrow(
      "Unsupported pair.",
    );
  });

  it("picks Sushi when it returns a higher out than Relay (local)", async () => {
    mockRelayOut(900_000n, 891_000n);
    vi.mocked(getSushiQuote).mockResolvedValue({ amountOut: 950_000n });

    const result = await computeBestQuote(MGC, USDT_BSC, 1_000_000n, "0xabc", 100);
    expect(result.provider).toBe("sushi");
    expect(result.output).toBe(950_000n);
    expect(result.routeLabel).toContain("Sushi");
  });

  it("picks Relay when it returns a higher out than Sushi (local)", async () => {
    mockRelayOut(960_000n, 950_000n);
    vi.mocked(getSushiQuote).mockResolvedValue({ amountOut: 950_000n });

    const result = await computeBestQuote(MGC, USDT_BSC, 1_000_000n, undefined, 100);
    expect(result.provider).toBe("relay");
    expect(result.output).toBe(960_000n);
  });

  it("falls back to Relay when Sushi has no route", async () => {
    mockRelayOut(900_000n, 891_000n);
    vi.mocked(getSushiQuote).mockResolvedValue(null);

    const result = await computeBestQuote(MGC, USDT_BSC, 1n, undefined, 100);
    expect(result.provider).toBe("relay");
  });

  it("skips Sushi for cross-chain (GOLDGR)", async () => {
    mockRelayOut(1n, 1n);
    await computeBestQuote(GOLDGR, USDT_BSC, 1n, undefined, 100);
    expect(getSushiQuote).not.toHaveBeenCalled();
    expect(getRelayQuote).toHaveBeenCalled();
  });

  it("uses applySlippage when Relay omits minimumAmount", async () => {
    mockRelayOut(1_000_000n, undefined);
    vi.mocked(getSushiQuote).mockResolvedValue(null);
    const result = await computeBestQuote(CAR, USDT_BSC, 1n, undefined, 100);
    expect(result.minOutput).toBe(990_000n);
  });

  it("passes USDT_TRON_ADDRESS as user for Tron source quotes", async () => {
    mockRelayOut(1n, 1n);
    await computeBestQuote(USDT_TRON, CAR, 1_000_000n, undefined, 100);
    expect(getRelayQuote).toHaveBeenCalledWith(
      expect.objectContaining({ user: USDT_TRON_ADDRESS }),
    );
    expect(getSushiQuote).not.toHaveBeenCalled();
  });
});

describe("computeRelayOnlyQuote alias", () => {
  it("still works and includes provider", async () => {
    mockRelayOut(900_000n, 891_000n);
    vi.mocked(getSushiQuote).mockResolvedValue(null);
    const result = await computeRelayOnlyQuote(CAR, USDT_BSC, 1_000_000n, "0xabc", 100);
    expect(result.provider).toBe("relay");
    expect(result.output).toBe(900_000n);
  });
});
