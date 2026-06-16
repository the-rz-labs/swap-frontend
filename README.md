# RzSwap Frontend

A Relay-style cross-chain swap UI for the RZ ecosystem. **One side of every swap is always on BNB
Chain** (one of the 17 RzSwap tokens); the other side can be any Relay-supported chain/token.

## How it works

The app composes two primitives, with **USDT on BNB Chain as the hub**:

| Direction | Example | Legs |
|---|---|---|
| Inbound | ETH (Ethereum) → CAR (BSC) | 1. Relay: ETH → USDT(BSC)  2. RzSwap: USDT → CAR |
| Outbound | CAR (BSC) → ETH (Ethereum) | 1. RzSwap: CAR → USDT(BSC)  2. Relay: USDT → ETH |
| Local | USDT (BSC) → CAR (BSC) | RzSwap only |

Each leg is an **explicit, user-confirmed step**. The intermediate USDT amount is measured by the
on-chain balance delta, so the second leg always uses the exact amount actually received.

## Stack

- **Next.js 14** (App Router, TypeScript)
- **wagmi v2 + viem** for chain reads/writes
- **Reown AppKit** (WalletConnect) for wallet connection
- **Relay SDK** (`@reservoir0x/relay-sdk`) for the cross-chain legs
- **Tailwind CSS**

## Setup

```bash
cp .env.local.example .env.local
# then fill in:
#   NEXT_PUBLIC_REOWN_PROJECT_ID   — from https://dashboard.reown.com
#   NEXT_PUBLIC_RZSWAP_ADDRESS     — deployed RzSwap address on BSC
npm install
npm run dev
```

Open http://localhost:3000.

## Key files

| File | Purpose |
|---|---|
| `lib/tokens.ts` | The 17 BSC tokens + curated remote tokens |
| `lib/rzswap.ts` | RzSwap ABI, address, and PancakeSwap path builders |
| `lib/relay.ts` | Relay client + quote/execute wrappers |
| `lib/swapPlan.ts` | Classifies a pair (local / inbound / outbound) and describes the legs |
| `hooks/useQuote.ts` | End-to-end read-only price quote |
| `hooks/useSwapFlow.ts` | Step-by-step executor (approvals, RzSwap swap, Relay execute) |
| `components/SwapCard.tsx` | The swap UI |

## Notes & TODO before mainnet

- **Token decimals** default to 18 in `lib/tokens.ts`; verify each token on-chain.
- **PancakeSwap paths** default to a direct `[tokenIn, tokenOut]` hop. If a token has no direct USDT
  pair, set `bscRouteHops` on it in `lib/tokens.ts` (e.g. route via WBNB or RZUSD).
- The contract must be **funded with output-token inventory** and the tokens **authorized** on
  RzSwap, or swaps revert with `InsufficientLiquidity` / `UnsupportedToken`.
