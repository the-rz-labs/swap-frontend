import { describe, it, expect } from "vitest";
import type { Execute } from "@reservoir0x/relay-sdk";
import { relayFeeUsd, relayMinimumOutput } from "./relay";

describe("relayMinimumOutput", () => {
  it("prefers lower route.destination minimum when currencyOut.minimumAmount equals amount", () => {
    const q = {
      details: {
        currencyOut: { amount: "2050811", minimumAmount: "2050811" },
        route: {
          destination: {
            inputCurrency: { amount: "2050811", minimumAmount: "1984775" },
          },
        },
      },
    } as unknown as Execute;
    expect(relayMinimumOutput(q)).toBe(1984775n);
  });

  it("keeps currencyOut.minimumAmount when it is already the lower floor", () => {
    const q = {
      details: {
        currencyOut: { amount: "2163543", minimumAmount: "2093877" },
        route: {
          destination: {
            inputCurrency: { amount: "2163543", minimumAmount: "2093877" },
          },
        },
      },
    } as unknown as Execute;
    expect(relayMinimumOutput(q)).toBe(2093877n);
  });
});

describe("relayFeeUsd", () => {
  it("prefers fees.relayer.amountUsd from Relay", () => {
    const q = {
      fees: {
        gas: { amountUsd: "0.001790" },
        relayer: { amountUsd: "0.042406" },
        relayerGas: { amountUsd: "0.020099" },
        relayerService: { amountUsd: "0.022308" },
      },
      details: {
        currencyIn: { amountUsd: "2.10" },
        currencyOut: { amountUsd: "2.05" },
        totalImpact: { usd: "-0.05" },
      },
    } as Execute;
    expect(relayFeeUsd(q)).toBeCloseTo(0.042406, 6);
  });

  it("sums relayerGas + relayerService when relayer missing", () => {
    const q = {
      fees: {
        relayerGas: { amountUsd: "0.02" },
        relayerService: { amountUsd: "0.03" },
      },
    } as Execute;
    expect(relayFeeUsd(q)).toBeCloseTo(0.05, 6);
  });

  it("falls back to |totalImpact.usd|", () => {
    const q = {
      details: { totalImpact: { usd: "-0.042324" } },
    } as Execute;
    expect(relayFeeUsd(q)).toBeCloseTo(0.042324, 6);
  });

  it("falls back to inUsd − outUsd", () => {
    const q = {
      details: {
        currencyIn: { amountUsd: "2.09798" },
        currencyOut: { amountUsd: "2.055656" },
      },
    } as Execute;
    expect(relayFeeUsd(q)).toBeCloseTo(0.042324, 5);
  });
});
