import { tokenKey, CHAIN_NAMES, type Token } from "./tokens";

/** Every user swap is quoted and executed through Relay only. */
export type SwapKind = "relay" | "invalid";

export type LegKind = "relay";

export type Leg = {
  kind: LegKind;
  title: string;
  detail: string;
};

export type SwapPlan = {
  kind: SwapKind;
  legs: Leg[];
  error?: string;
};

/**
 * Classifies a from/to pair.
 * Relay when the two tokens differ; invalid when they are the same asset.
 */
export function classify(from: Token, to: Token): SwapKind {
  return tokenKey(from) !== tokenKey(to) ? "relay" : "invalid";
}

/**
 * Produces the execution leg(s) for a swap.
 * Relay-only: one relay leg when tokens differ.
 */
export function planSwap(from: Token, to: Token): SwapPlan {
  const kind = classify(from, to);

  if (kind === "invalid") {
    return { kind, legs: [], error: "Choose two different tokens." };
  }

  const fromChain = CHAIN_NAMES[from.chainId] ?? `chain ${from.chainId}`;
  const toChain = CHAIN_NAMES[to.chainId] ?? `chain ${to.chainId}`;
  const sameChain = from.chainId === to.chainId;

  const detail = sameChain
    ? `${from.symbol} → ${to.symbol} on ${fromChain} via Relay`
    : `${from.symbol} (${fromChain}) → ${to.symbol} (${toChain}) via Relay`;

  return {
    kind: "relay",
    legs: [
      {
        kind: "relay",
        title: "Swap via Relay",
        detail,
      },
    ],
  };
}

/** Applies a slippage tolerance (bps) to an amount, returning the floor. */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}
