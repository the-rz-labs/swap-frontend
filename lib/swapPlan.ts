import { isBscToken, USDT_BSC, tokenKey, CHAIN_NAMES, type Token } from "./tokens";

/**
 * Routing mode:
 *  - "rzswap": route the BSC leg through our RzSwap treasury contract (controlled pricing).
 *  - "relay" : let Relay handle the entire swap via its own DEX aggregation (market pricing).
 */
export type SwapMode = "rzswap" | "relay";

export type SwapKind = "local" | "inbound" | "outbound" | "invalid";

export type LegKind = "relay" | "rzswap";

export type Leg = {
  kind: LegKind;
  title: string;
  detail: string;
};

export type SwapPlan = {
  kind: SwapKind;
  /** Whether the BSC side equals the USDT hub (then no RzSwap leg is needed — pure bridge). */
  hubIsEndpoint: boolean;
  legs: Leg[];
  error?: string;
};

function isHub(t: Token): boolean {
  return tokenKey(t) === tokenKey(USDT_BSC);
}

/**
 * Classifies a from/to pair. The invariant enforced by the UI is that exactly one side is a BSC
 * token; the other side is a remote token routed through Relay (with USDT on BSC as the hub).
 */
export function classify(from: Token, to: Token): SwapKind {
  const fromBsc = isBscToken(from);
  const toBsc = isBscToken(to);
  if (fromBsc && toBsc) return "local";
  if (fromBsc && !toBsc) return "outbound";
  if (!fromBsc && toBsc) return "inbound";
  return "invalid";
}

/**
 * Produces the ordered execution legs for a swap, mirroring exactly what the executor runs:
 *
 *  - local    : [RzSwap]                      tokenA(BSC) → tokenB(BSC)
 *  - outbound : [RzSwap, Relay]               rz(BSC) → USDT(BSC) → remote   (RzSwap skipped if from = USDT)
 *  - inbound  : [Relay, RzSwap]               remote → USDT(BSC) → rz(BSC)   (RzSwap skipped if to = USDT)
 */
export function planSwap(from: Token, to: Token): SwapPlan {
  const kind = classify(from, to);

  if (kind === "invalid") {
    return { kind, hubIsEndpoint: false, legs: [], error: "One side of the swap must be a BNB Chain token." };
  }
  if (tokenKey(from) === tokenKey(to)) {
    return { kind: "invalid", hubIsEndpoint: false, legs: [], error: "Choose two different tokens." };
  }

  if (kind === "local") {
    return {
      kind,
      hubIsEndpoint: false,
      legs: [
        {
          kind: "rzswap",
          title: "Swap on BNB Chain",
          detail: `${from.symbol} → ${to.symbol} via RzSwap`,
        },
      ],
    };
  }

  if (kind === "outbound") {
    const remoteChain = CHAIN_NAMES[to.chainId] ?? `chain ${to.chainId}`;
    if (isHub(from)) {
      return {
        kind,
        hubIsEndpoint: true,
        legs: [{ kind: "relay", title: `Bridge to ${remoteChain}`, detail: `USDT (BNB) → ${to.symbol} (${remoteChain}) via Relay` }],
      };
    }
    return {
      kind,
      hubIsEndpoint: false,
      legs: [
        { kind: "rzswap", title: "Swap on BNB Chain", detail: `${from.symbol} → USDT via RzSwap` },
        { kind: "relay", title: `Bridge to ${remoteChain}`, detail: `USDT (BNB) → ${to.symbol} (${remoteChain}) via Relay` },
      ],
    };
  }

  // inbound
  const remoteChain = CHAIN_NAMES[from.chainId] ?? `chain ${from.chainId}`;
  if (isHub(to)) {
    return {
      kind,
      hubIsEndpoint: true,
      legs: [{ kind: "relay", title: "Bridge to BNB Chain", detail: `${from.symbol} (${remoteChain}) → USDT (BNB) via Relay` }],
    };
  }
  // ONE signature: Relay bridges to USDT delivered to the handler on BNB Chain and, in the same
  // fill, calls fulfill() which swaps it into the token via RzSwap (USDT fallback on failure).
  return {
    kind,
    hubIsEndpoint: false,
    legs: [
      {
        kind: "relay",
        title: `Buy ${to.symbol}`,
        detail: `${from.symbol} (${remoteChain}) → ${to.symbol} (BNB): bridge + swap, one signature`,
      },
    ],
  };
}

/** Applies a slippage tolerance (bps) to an amount, returning the floor. */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}
