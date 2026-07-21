# RzSwap Frontend

A Relay-style cross-chain swap UI for the RZ ecosystem. **One side of every swap is always on BNB
Chain** (one of the 17 RzSwap tokens); the other side can be any Relay-supported chain/token.

> **Frontend devs:** see [`docs/RELAY_INTEGRATION.md`](docs/RELAY_INTEGRATION.md) for how the
> Relay × RzSwap composition works and how to implement/extend it.

## How it works

The app composes two primitives, with **USDT on BNB Chain as the hub**, minimizing transactions:

| Direction | Example | Transactions |
|---|---|---|
| Inbound | ETH (Ethereum) → CAR (BSC) | **1 tx** — Relay bridges ETH→USDT(BSC) **and** runs `RzSwap.swap(USDT→CAR)` in the same fill (destination `txs`), delivering CAR to you. |
| Outbound | CAR (BSC) → ETH (Ethereum) | **2 tx, auto** — RzSwap: CAR→USDT(BSC), then Relay: USDT→ETH. Runs back-to-back from one click. |
| Local | USDT (BSC) → CAR (BSC) | **1 tx** — RzSwap only. |

**Inbound (single tx):** the swap is appended to Relay's fill via the quote `txs` field and executed
by Relay's multicaller. The swap's input is pinned to the bridge's *guaranteed minimum* USDT output
(so it can never revert for lack of balance), surplus is refunded to you, and `refundOnOrigin` returns
your funds on the source chain if the on-arrival swap can't fill. See
`hooks/useSwapFlow.ts` → `makeInboundBridgeSwapLeg`.

**Outbound:** the on-chain RzSwap leg's USDT output is measured by balance delta and handed to the
Relay leg, which then runs automatically.

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

## Deploy to Vercel

1. **Import the repo** into Vercel (New Project → import this Git repo).
2. **Root Directory:** this standalone `swap-frontend` repo has the app at its root, so leave Root
   Directory as the default (`.`). _(If you instead deploy from the `cross-chain-swap` monorepo, set
   Root Directory = `frontend`.)_ Vercel auto-detects Next.js — leave the rest as detected.
3. **Add Environment Variables** (Project → Settings → Environment Variables), for all environments:

   | Variable | Required | Value |
   |---|---|---|
   | `NEXT_PUBLIC_REOWN_PROJECT_ID` | ✅ | your Reown project id |
   | `NEXT_PUBLIC_RZSWAP_ADDRESS` | ✅ | deployed RzSwap address on BSC |
   | `NEXT_PUBLIC_APP_URL` | recommended | your Vercel URL, e.g. `https://rzswap.vercel.app` |
   | `NEXT_PUBLIC_RELAY_SOURCE` | optional | your app domain |

4. In the **Reown dashboard**, add your Vercel domain to the project's **allowed domains** (otherwise
   WalletConnect connections are rejected).
5. **Deploy.**

Notes:
- All `NEXT_PUBLIC_*` vars are **inlined at build time** — after changing any, trigger a redeploy.
- Node is pinned to **20.x** (`.nvmrc` / `engines`).
- No server secrets are used; everything is public client config.
- The build runs `next lint`; a local root `.eslintrc.json` (`root: true`) keeps it self-contained.
- RPC is handled by Reown's infra via your project id (no RPC env needed). For heavy traffic,
  consider wiring dedicated BSC/ETH RPC transports into the `WagmiAdapter`.

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


## Routing

The BSC leg path is resolved **automatically** at quote/execution time (`lib/route.ts`): it probes
the direct pair plus routes via WBNB / USDT / RZUSD and keeps the candidate with the best on-chain
quote. Most RZ tokens (e.g. CAR) only have a WBNB pair, so the direct `[token, USDT]` path reverts
and the WBNB route is used instead. Add more bases to `INTERMEDIARIES` if a token needs them.

## Notes & TODO before mainnet

- **Token decimals** default to 18 in `lib/tokens.ts`; verify each token on-chain.
- The contract must be **funded with output-token inventory** and the tokens **authorized** on
  RzSwap, or swaps revert with `InsufficientLiquidity` / `UnsupportedToken`.
