import {
  isBscToken,
  USDT_BSC,
  USDT_ETH,
  tokenKey,
  CHAIN_NAMES,
  involvesGoldgr,
  isGoldgr,
  type Token,
} from "./tokens";

// Every swap routes a treasury leg through RzSwap (controlled pricing); Relay only moves USDT.
// GOLDGR uses the ETH hub; all other routes keep the BSC-hub planner below.

export type SwapKind =
  | "local"
  | "inbound"
  | "outbound"
  | "local-eth"
  | "buy-goldgr"
  | "sell-goldgr"
  | "bsc-to-goldgr"
  | "invalid";

export type LegKind = "relay" | "rzswap";

export type Leg = {
  kind: LegKind;
  title: string;
  detail: string;
};

export type SwapPlan = {
  kind: SwapKind;
  /** Whether the hub USDT equals an endpoint (then no treasury swap on that side). */
  hubIsEndpoint: boolean;
  legs: Leg[];
  error?: string;
};

function isHubBsc(t: Token): boolean {
  return tokenKey(t) === tokenKey(USDT_BSC);
}

function isHubEth(t: Token): boolean {
  return tokenKey(t) === tokenKey(USDT_ETH);
}

/**
 * Classifies a from/to pair.
 * Non-GOLDGR: exactly one side BSC (legacy).
 * GOLDGR: see planGoldgrSwap.
 */
export function classify(from: Token, to: Token): SwapKind {
  if (involvesGoldgr(from, to)) return classifyGoldgr(from, to);

  const fromBsc = isBscToken(from);
  const toBsc = isBscToken(to);
  if (fromBsc && toBsc) return "local";
  if (fromBsc && !toBsc) return "outbound";
  if (!fromBsc && toBsc) return "inbound";
  return "invalid";
}

function classifyGoldgr(from: Token, to: Token): SwapKind {
  if (tokenKey(from) === tokenKey(to)) return "invalid";

  // Local ETH treasury: USDT(ETH) ↔ GOLDGR
  if ((isHubEth(from) && isGoldgr(to)) || (isGoldgr(from) && isHubEth(to))) return "local-eth";

  // Destination GOLDGR
  if (isGoldgr(to)) {
    if (isBscToken(from) && !isHubBsc(from)) return "bsc-to-goldgr";
    return "buy-goldgr"; // USDT(BSC), ETH, USDC, Tron, …
  }

  // Source GOLDGR
  if (isGoldgr(from)) return "sell-goldgr";

  return "invalid";
}

function planGoldgrSwap(from: Token, to: Token): SwapPlan {
  const kind = classifyGoldgr(from, to);

  if (kind === "invalid") {
    return { kind, hubIsEndpoint: false, legs: [], error: "Unsupported GOLDGR route." };
  }

  if (kind === "local-eth") {
    return {
      kind,
      hubIsEndpoint: false,
      legs: [
        {
          kind: "rzswap",
          title: "Swap on Ethereum",
          detail: `${from.symbol} → ${to.symbol} via ETH RzSwap`,
        },
      ],
    };
  }

  if (kind === "buy-goldgr") {
    const remoteChain = CHAIN_NAMES[from.chainId] ?? `chain ${from.chainId}`;
    return {
      kind,
      hubIsEndpoint: false,
      legs: [
        {
          kind: "relay",
          title: "Buy GOLDGR",
          detail: `${from.symbol} (${remoteChain}) → GOLDGR (Ethereum): bridge + swap, one signature`,
        },
      ],
    };
  }

  if (kind === "bsc-to-goldgr") {
    return {
      kind,
      hubIsEndpoint: false,
      legs: [
        {
          kind: "rzswap",
          title: "Sell on BNB Chain",
          detail: `${from.symbol} → USDT → GOLDGR (Ethereum) via Relay + ETH treasury`,
        },
      ],
    };
  }

  // sell-goldgr
  if (isBscToken(to) && !isHubBsc(to)) {
    return {
      kind: "sell-goldgr",
      hubIsEndpoint: false,
      legs: [
        {
          kind: "rzswap",
          title: "Sell GOLDGR",
          detail: `GOLDGR → USDT → ${to.symbol} (BNB) via Relay + BSC treasury`,
        },
      ],
    };
  }
  if (isHubBsc(to)) {
    return {
      kind: "sell-goldgr",
      hubIsEndpoint: true,
      legs: [
        {
          kind: "rzswap",
          title: "Sell GOLDGR",
          detail: `GOLDGR → USDT (BNB) via Relay`,
        },
      ],
    };
  }
  const remoteChain = CHAIN_NAMES[to.chainId] ?? `chain ${to.chainId}`;
  return {
    kind: "sell-goldgr",
    hubIsEndpoint: true,
    legs: [
      {
        kind: "rzswap",
        title: "Sell GOLDGR",
        detail: `GOLDGR → ${to.symbol} (${remoteChain}) via Relay`,
      },
    ],
  };
}

/**
 * Produces the ordered execution legs for a swap.
 *
 * Non-GOLDGR (unchanged):
 *  - local    : [RzSwap] BSC
 *  - outbound : [RzSwap, Relay] or pure Relay
 *  - inbound  : [Relay] (+ RzSwap buy)
 *
 * GOLDGR: see planGoldgrSwap.
 */
export function planSwap(from: Token, to: Token): SwapPlan {
  if (involvesGoldgr(from, to)) {
    if (tokenKey(from) === tokenKey(to)) {
      return { kind: "invalid", hubIsEndpoint: false, legs: [], error: "Choose two different tokens." };
    }
    return planGoldgrSwap(from, to);
  }

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
    if (isHubBsc(from)) {
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
  if (isHubBsc(to)) {
    return {
      kind,
      hubIsEndpoint: true,
      legs: [{ kind: "relay", title: "Bridge to BNB Chain", detail: `${from.symbol} (${remoteChain}) → USDT (BNB) via Relay` }],
    };
  }
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
