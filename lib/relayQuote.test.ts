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

import {
  getRelayQuote,
  relayOutputAmount,
  relayMinimumOutput,
  relayUsd,
  relayFeeUsd,
} from "./relay";
import { computeRelayOnlyQuote } from "./relayQuote";

const CAR = BSC_TOKENS.find((t) => t.symbol === "CAR")!;
const USDT_TRON = TRON_TOKENS.find((t) => t.symbol === "USDT")!;
const FAKE_QUOTE = { steps: [] } as Execute;

beforeEach(() => {
  vi.mocked(getRelayQuote).mockReset();
  vi.mocked(relayOutputAmount).mockReset();
  vi.mocked(relayMinimumOutput).mockReset();
  vi.mocked(relayUsd).mockReset();
  vi.mocked(relayFeeUsd).mockReset();
});

describe("computeRelayOnlyQuote", () => {
  it("rejects same-token pairs", async () => {
    await expect(
      computeRelayOnlyQuote(CAR, CAR, 1_000n, undefined, 100),
    ).rejects.toThrow("Unsupported pair.");
    expect(getRelayQuote).not.toHaveBeenCalled();
  });

  it("quotes via Relay with no custom txs", async () => {
    vi.mocked(getRelayQuote).mockResolvedValue(FAKE_QUOTE);
    vi.mocked(relayOutputAmount).mockReturnValue(900_000n);
    vi.mocked(relayMinimumOutput).mockReturnValue(891_000n);
    vi.mocked(relayUsd).mockReturnValue({ inUsd: 10, outUsd: 9.5 });
    vi.mocked(relayFeeUsd).mockReturnValue(0.5);

    const result = await computeRelayOnlyQuote(CAR, USDT_BSC, 1_000_000n, "0xabc", 100);

    expect(getRelayQuote).toHaveBeenCalledWith({
      fromChainId: CAR.chainId,
      fromCurrency: CAR.address,
      toChainId: USDT_BSC.chainId,
      toCurrency: USDT_BSC.address,
      amount: "1000000",
      recipient: "0xabc",
      user: undefined,
    });
    expect(result).toEqual({
      output: 900_000n,
      minOutput: 891_000n,
      inputUsd: 10,
      outputUsd: 9.5,
      bridgeFeeUsd: 0.5,
    });
  });

  it("uses applySlippage on output when Relay omits minimumAmount", async () => {
    vi.mocked(getRelayQuote).mockResolvedValue(FAKE_QUOTE);
    vi.mocked(relayOutputAmount).mockReturnValue(1_000_000n);
    vi.mocked(relayMinimumOutput).mockReturnValue(undefined);
    vi.mocked(relayUsd).mockReturnValue({});
    vi.mocked(relayFeeUsd).mockReturnValue(undefined);

    const result = await computeRelayOnlyQuote(CAR, USDT_BSC, 1n, undefined, 100);
    expect(result.minOutput).toBe(990_000n);
  });

  it("passes USDT_TRON_ADDRESS as user for Tron source quotes", async () => {
    vi.mocked(getRelayQuote).mockResolvedValue(FAKE_QUOTE);
    vi.mocked(relayOutputAmount).mockReturnValue(1n);
    vi.mocked(relayMinimumOutput).mockReturnValue(1n);
    vi.mocked(relayUsd).mockReturnValue({});
    vi.mocked(relayFeeUsd).mockReturnValue(undefined);

    await computeRelayOnlyQuote(USDT_TRON, CAR, 1_000_000n, undefined, 100);

    expect(getRelayQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        fromChainId: USDT_TRON.chainId,
        user: USDT_TRON_ADDRESS,
      }),
    );
  });

  it("uses funded USDT Tron address as recipient when dest is Tron and recipient missing", async () => {
    vi.mocked(getRelayQuote).mockResolvedValue(FAKE_QUOTE);
    vi.mocked(relayOutputAmount).mockReturnValue(1n);
    vi.mocked(relayMinimumOutput).mockReturnValue(1n);
    vi.mocked(relayUsd).mockReturnValue({});
    vi.mocked(relayFeeUsd).mockReturnValue(undefined);

    await computeRelayOnlyQuote(CAR, USDT_TRON, 1n, undefined, 100);

    expect(getRelayQuote).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: USDT_TRON_ADDRESS }),
    );
  });

  it("throws when Relay returns no output amount", async () => {
    vi.mocked(getRelayQuote).mockResolvedValue(FAKE_QUOTE);
    vi.mocked(relayOutputAmount).mockReturnValue(undefined);

    await expect(
      computeRelayOnlyQuote(GOLDGR, USDT_BSC, 1n, undefined, 100),
    ).rejects.toThrow("Relay returned no output amount.");
  });
});
