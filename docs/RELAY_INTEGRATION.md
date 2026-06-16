# Relay × RzSwap — Frontend Integration

How the cross-chain swap frontend is built. The app composes **two primitives** with **USDT on BNB
Chain (BSC) as the hub**:

- **RzSwap** — our treasury contract on BSC. Prices via PancakeSwap + an oracle deviation check and
  pays the output token out of its own inventory. Handles the *BSC-local* leg.
- **Relay** (`@reservoir0x/relay-sdk`) — third-party cross-chain bridge/aggregator. Handles the
  *cross-chain* leg between BSC USDT and any supported remote chain/token.

**Invariant:** exactly one side of every swap is a BSC RZ-ecosystem token; the other side is any
Relay-supported chain/token. The UI enforces this.

---

## 1. The three flows

| Flow | Example | Transactions | Who does what |
|---|---|---|---|
| **Local** | USDT(BSC) → CAR(BSC) | **1 tx** | RzSwap only |
| **Inbound** | ETH(Ethereum) → CAR(BSC) | **1 tx** | Relay bridges ETH→USDT **and** runs `RzSwap.swap` in the same fill |
| **Outbound** | CAR(BSC) → ETH(Ethereum) | **2 tx, auto** | RzSwap: CAR→USDT, then Relay: USDT→ETH (run back-to-back) |

Direction is classified purely from the two selected tokens — see `lib/swapPlan.ts` → `classify()` /
`planSwap()`. `hubIsEndpoint` is true when the BSC side *is* USDT (then there's no RzSwap leg — it's
a plain bridge).

---

## 2. SDK setup

`lib/relay.ts` — configure the client once (idempotent), mainnet API, BSC + the remote chains:

```ts
createClient({
  baseApiUrl: MAINNET_RELAY_API,
  source: process.env.NEXT_PUBLIC_RELAY_SOURCE ?? "rzswap.app",
  chains: [bsc, mainnet, arbitrum, base, optimism, polygon].map(convertViemChainToRelayChain),
});
```

Two wrappers do all the work:

- `getRelayQuote(input)` → `Execute` quote. Always `EXACT_INPUT`. Accepts optional `txs`
  (destination calls) and `refundOnOrigin`.
- `executeRelay(quote, wallet, onProgress)` → submits and tracks. `wallet` is the wagmi
  `WalletClient` for the **origin** chain.

Helpers: `relayOutputAmount(quote)` (expected out) and `relayMinimumOutput(quote)` (guaranteed
floor) read `quote.details.currencyOut.{amount,minimumAmount}`.

> **Native token = zero address** (`0x000…0`). ERC-20 = its address. See `lib/tokens.ts`.

---

## 3. Quoting (read-only) — `hooks/useQuote.ts`

End-to-end estimate, composed per direction:

- **Local / BSC legs:** `resolveBestBscPath(amountIn, from, to)` (see §6) — never call
  `getOutputAmount` with a hardcoded path.
- **Inbound:** Relay quote `remote → USDT(BSC)` → take `currencyOut.amount` → RzSwap
  `USDT → token` for the final estimate.
- **Outbound:** RzSwap `token → USDT` → feed that USDT into a Relay quote `USDT(BSC) → remote`.

A cross-chain quote needs a `recipient` (the connected address). Quotes are debounced and refetched
on an interval (react-query).

---

## 4. Execution — `hooks/useSwapFlow.ts`

The flow builds an ordered list of **legs** and runs them sequentially from one click (`start()`),
with `retry()` resuming from a failed leg. Each leg switches the wallet to the right chain itself.

### 4a. Inbound = **single transaction** (`makeInboundBridgeSwapLeg`)

Relay's quote accepts a `txs` array of destination-chain calls executed by its multicaller after the
bridge fills. We append `approve(USDT→RzSwap)` + `RzSwap.swap(USDT→token, receiver = user)`:

```ts
// 1. plain quote → guaranteed USDT delivered on BSC
const usdtMin = relayMinimumOutput(prelimQuote);

// 2. pin the swap input UNDER the guaranteed min so the on-arrival swap can never revert
//    for lack of balance; surplus is refunded to the user by Relay.
const swapAmountIn = (usdtMin * 99n) / 100n;
const { path, amountOut } = await resolveBestBscPath(swapAmountIn, USDT, token);

const txs = [
  { to: USDT,   value: "0", data: encodeFunctionData({ abi: ERC20_ABI,  functionName: "approve", args: [RZSWAP, swapAmountIn] }) },
  { to: RZSWAP, value: "0", data: encodeFunctionData({ abi: RZSWAP_ABI, functionName: "swap",    args: [{ tokenIn: USDT, tokenOut: token, amountIn: swapAmountIn, minAmountOut: applySlippage(amountOut, slippageBps), receiver: user, path }] }) },
];

const quote = await getRelayQuote({ /* remote → USDT */, txs, refundOnOrigin: true });
await executeRelay(quote, wallet, onProgress); // ONE signature: the origin deposit
```

Key points:
- **Amount pinning:** the swap input must be ≤ the USDT the multicaller actually receives. Use
  `relayMinimumOutput`; if the with-`txs` quote's min comes back lower, re-pin once. Surplus dust is
  refunded to the user.
- **`refundOnOrigin: true`** — if the on-arrival swap can't fill (e.g. treasury too low), Relay
  refunds the user on the **source** chain. Fail-safe: worst case is "no swap," never lost funds.
- The user receives the RZ token directly; no second tx.

### 4b. Outbound = **2 tx, auto-orchestrated**

1. `makeRzSwapLeg(from → USDT)` on BSC. The produced USDT is measured by **balance delta**
   (`balanceAfter − balanceBefore`) and stored as the exact bridge input.
2. `makeRelayLeg(USDT → remote)` runs automatically with that amount. No manual "confirm step 2".

### 4c. Local = **1 tx**

`makeRzSwapLeg(from → to)` — approve (exact amount) then `RzSwap.swap`.

---

## 5. Error handling — `lib/relayErrors.ts`

The Relay SDK fires a best-effort `POST /transactions/index` ("notify the solver") **without
awaiting or catching it**. When Relay's backend transiently returns *"Transaction receipt not found
for txHash"*, it surfaces as an **unhandled promise rejection** (Next.js error overlay) even though
the bridge is fine.

`installRelayRejectionGuard()` (called from `app/providers.tsx`) adds a `window` `unhandledrejection`
listener that swallows **only** this benign error (matched by endpoint `/transactions/index` and the
"receipt not found" message). All other rejections propagate. Don't broaden the matcher.

---

## 6. Path resolution — `lib/route.ts` (important)

Many RZ tokens have **no direct USDT PancakeSwap pair** (e.g. CAR only pairs with WBNB), so a direct
`[token, USDT]` path makes `getOutputAmount` revert with `PricingFailed`. **Always** resolve the BSC
path with `resolveBestBscPath(amountIn, from, to)`: it probes `direct`, `via WBNB`, `via USDT`, `via
RZUSD`, quotes each on-chain, and returns the candidate with the best output. Add new bases to
`INTERMEDIARIES` if a token needs them.

---

## 7. Contract calls — `lib/rzswap.ts`

- `RZSWAP_ABI` includes the functions **and the custom errors** (`PricingFailed`, `SlippageExceeded`,
  `InsufficientLiquidity`, …) so viem decodes reverts to readable names — keep errors in sync with
  `src/RzSwap.sol`.
- Approvals are **exact-amount** (not infinite): see `ensureAllowance` in `useSwapFlow.ts`.
- BSC reads use `readContract(..., { chainId: 56 })` regardless of the wallet's current chain.

---

## 8. Config / env

```
NEXT_PUBLIC_REOWN_PROJECT_ID   # Reown AppKit (wallet connect)
NEXT_PUBLIC_RZSWAP_ADDRESS     # deployed RzSwap on BSC
NEXT_PUBLIC_RELAY_SOURCE       # optional Relay attribution tag
```

`RZSWAP_CONFIGURED` guards UI/quotes when the address isn't set.

---

## 9. Gotchas / checklist for changes

- [ ] **Never** build a BSC path by hand — use `resolveBestBscPath`.
- [ ] Cross-chain quotes require a connected `recipient`.
- [ ] Keep `RZSWAP_ABI` errors in sync with the contract.
- [ ] For inbound `txs`, pin the swap amount to the bridge **minimum**, set `refundOnOrigin: true`,
      and `receiver = user`.
- [ ] Verify each token's **decimals** in `lib/tokens.ts` (currently all 18) and add `INTERMEDIARIES`
      bases for any token lacking a direct/WBNB route.
- [ ] The RzSwap treasury must be **funded** with the output token and the token **authorized**, or
      swaps revert (`InsufficientLiquidity` / `UnsupportedToken`).
- [ ] Don't broaden the Relay rejection guard beyond the benign solver-notification error.

---

## 10. Trust model (state this to users)

Each individual swap is **atomic and fail-safe** — a failed swap reverts (or refunds on origin); the
user never loses principal. The cross-chain leg trusts **Relay** as the bridge, and the BSC leg uses
the **RzSwap treasury** (a trusted-operator pool). See the contract security notes in the repo root.
