"use client";

import { useCallback, useRef, useState } from "react";
import { type Address, type WalletClient } from "viem";
import {
  readContract,
  writeContract,
  waitForTransactionReceipt,
  switchChain,
  getWalletClient,
} from "@wagmi/core";
import { wagmiConfig } from "@/lib/wagmi";
import { BSC_CHAIN_ID, USDT_BSC, type Token } from "@/lib/tokens";
import { RZSWAP_ABI, ERC20_ABI, RZSWAP_ADDRESS } from "@/lib/rzswap";
import { resolveBestBscPath } from "@/lib/route";
import { getRelayQuote, executeRelay, relayOutputAmount, relayMinimumOutput } from "@/lib/relay";
import { isBenignRelaySolverError } from "@/lib/relayErrors";
import { planSwap, applySlippage } from "@/lib/swapPlan";
import { buildBuyFulfillTx, BRIDGE_SWAP_HANDLER, HANDLERS_CONFIGURED } from "@/lib/handlers";

export type LegStatus = "pending" | "active" | "done" | "error";

export type RunLeg = {
  key: string;
  label: string;
  status: LegStatus;
  txHash?: string;
  chainId?: number;
  note?: string;
  error?: string;
};

export type FlowStatus = "idle" | "awaiting" | "running" | "done" | "error";

export type SwapContext = {
  from: Token;
  to: Token;
  amountIn: bigint;
  slippageBps: number;
  address: Address;
  /** Correlation id passed to RzSwap.swap and emitted in the Swapped event (for backend matching). */
  swapId: `0x${string}`;
};

type LegRunner = () => Promise<void>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ensures the wallet is on `chainId`, switching if necessary. */
async function ensureChain(chainId: number) {
  await switchChain(wagmiConfig, { chainId });
}

/** Approves `spender` for `amount` of `token` on `chainId` if the current allowance is short. */
async function ensureAllowance(token: Address, owner: Address, spender: Address, amount: bigint, chainId: number) {
  const current = (await readContract(wagmiConfig, {
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
    chainId,
  })) as bigint;
  if (current >= amount) return;
  const hash = await writeContract(wagmiConfig, {
    address: token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
    chainId,
  });
  await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
}

async function bscTokenBalance(token: Address, owner: Address): Promise<bigint> {
  return (await readContract(wagmiConfig, {
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
    chainId: BSC_CHAIN_ID,
  })) as bigint;
}

/**
 * Drives a swap as a sequence of user-confirmed legs. The BSC↔USDT hub leg(s) run on RzSwap and
 * the cross-chain leg(s) run on Relay; intermediate USDT amounts are measured by treasury balance
 * delta so the second leg always uses the exact amount actually received.
 */
export function useSwapFlow() {
  const [legs, setLegs] = useState<RunLeg[]>([]);
  const [current, setCurrent] = useState(0);
  const [status, setStatus] = useState<FlowStatus>("idle");

  const runnersRef = useRef<LegRunner[]>([]);
  // intermediate: USDT produced by an outbound rz→USDT swap (measured on-chain).
  // usdtBefore: the user's USDT balance captured before an inbound bridge, so the follow-up
  // USDT→rz swap can use the exact bridged amount (current balance − usdtBefore) at its own runtime.
  const ctxRef = useRef<{ intermediate: bigint; usdtBefore: bigint }>({ intermediate: 0n, usdtBefore: 0n });

  const patchLeg = useCallback((index: number, patch: Partial<RunLeg>) => {
    setLegs((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }, []);

  const reset = useCallback(() => {
    runnersRef.current = [];
    ctxRef.current = { intermediate: 0n, usdtBefore: 0n };
    setLegs([]);
    setCurrent(0);
    setStatus("idle");
  }, []);

  // ── leg builders ────────────────────────────────────────────────────────

  /**
   * RzSwap leg: tokenIn → tokenOut on BSC. When `useIntermediate` (inbound USDT→rz second leg),
   * the input is the bridged USDT measured as (current USDT balance − usdtBefore) at runtime — so
   * it is robust to flaky bridge tracking and always uses the exact amount actually received.
   */
  const makeRzSwapLeg = useCallback(
    (ctx: SwapContext, tokenIn: Token, tokenOut: Token, useIntermediate: boolean): LegRunner =>
      async () => {
        await ensureChain(BSC_CHAIN_ID);
        let amountIn: bigint;
        if (useIntermediate) {
          // The bridged USDT may land a moment after the bridge leg resolves — poll briefly for it,
          // then swap the EXACT amount received (no leftover USDT change).
          let delta = 0n;
          for (let i = 0; i < 20; i++) {
            const cur = await bscTokenBalance(USDT_BSC.address, ctx.address);
            delta = cur > ctxRef.current.usdtBefore ? cur - ctxRef.current.usdtBefore : 0n;
            if (delta > 0n) break;
            await sleep(3000);
          }
          amountIn = delta > 0n ? delta : ctxRef.current.intermediate;
          if (amountIn <= 0n) {
            throw new Error("Bridged USDT not received yet — wait a moment, then retry this step.");
          }
        } else {
          amountIn = ctx.amountIn;
          if (amountIn <= 0n) throw new Error("No input amount available for the on-chain swap.");
        }

        // Resolve the best live PancakeSwap path (direct or via WBNB/USDT/RZUSD) for this amount.
        const { path, amountOut: quoted } = await resolveBestBscPath(amountIn, tokenIn.address, tokenOut.address);
        const minOut = applySlippage(quoted, ctx.slippageBps);

        await ensureAllowance(tokenIn.address, ctx.address, RZSWAP_ADDRESS, amountIn, BSC_CHAIN_ID);

        // Track tokenOut balance so an outbound hub swap can hand the exact USDT amount to Relay.
        const before = await bscTokenBalance(tokenOut.address, ctx.address);

        const hash = await writeContract(wagmiConfig, {
          address: RZSWAP_ADDRESS,
          abi: RZSWAP_ABI,
          functionName: "swap",
          args: [
            {
              swapId: ctx.swapId,
              tokenIn: tokenIn.address,
              tokenOut: tokenOut.address,
              amountIn,
              minAmountOut: minOut,
              receiver: ctx.address,
              path,
            },
          ],
          chainId: BSC_CHAIN_ID,
        });
        const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: BSC_CHAIN_ID });

        const after = await bscTokenBalance(tokenOut.address, ctx.address);
        if (tokenOut.address.toLowerCase() === USDT_BSC.address.toLowerCase()) {
          ctxRef.current.intermediate = after > before ? after - before : 0n;
        }
        return void receipt;
      },
    [],
  );

  /** Relay leg between BSC USDT and a remote token, in either direction. */
  const makeRelayLeg = useCallback(
    (
      ctx: SwapContext,
      fromChainId: number,
      fromCurrency: Address,
      toChainId: number,
      toCurrency: Address,
      useIntermediate: boolean,
      measureBscUsdt: boolean,
      legIndex: number,
    ): LegRunner =>
      async () => {
        await ensureChain(fromChainId);
        const wallet = (await getWalletClient(wagmiConfig, { chainId: fromChainId })) as WalletClient;
        const amount = useIntermediate ? ctxRef.current.intermediate : ctx.amountIn;
        if (amount <= 0n) throw new Error("No input amount available for the bridge.");

        // For an inbound bridge, snapshot the USDT balance so the follow-up swap can measure the
        // exact bridged amount itself (decoupled from this leg's tracking).
        if (measureBscUsdt) {
          ctxRef.current.usdtBefore = await bscTokenBalance(USDT_BSC.address, ctx.address);
        }

        const quote = await getRelayQuote({
          fromChainId,
          fromCurrency,
          toChainId,
          toCurrency,
          amount: amount.toString(),
          recipient: ctx.address,
          wallet,
        });

        let sawTxHash = false;
        try {
          await executeRelay(quote, wallet, (data) => {
            const tx = data.txHashes?.[0];
            if (tx) {
              sawTxHash = true;
              patchLeg(legIndex, { txHash: tx.txHash, chainId: tx.chainId });
            }
          });
        } catch (e) {
          // Once the deposit is broadcast the bridge is in-flight; don't fail the leg on a transient
          // post-deposit tracking error (e.g. Relay's best-effort solver ping). Real pre-deposit
          // failures (rejected signature, quote error) still propagate.
          if (!sawTxHash || !isBenignRelaySolverError(e)) throw e;
          patchLeg(legIndex, { note: "Bridge submitted — Relay is confirming; funds will arrive shortly." });
        }

        // Fallback hint for the outbound direction (the inbound swap re-measures at its own runtime).
        ctxRef.current.intermediate = relayOutputAmount(quote) ?? ctxRef.current.intermediate;
      },
    [patchLeg],
  );

  /**
   * BUY leg (inbound, 1 signature): Relay bridges the user's asset to USDT delivered to the
   * BridgeSwapHandler on BSC AND, in the same fill, calls fulfill() which swaps that USDT into the
   * target token via RzSwap and sends it to the user. On any failure the handler delivers USDT to
   * the user instead (fallback). Replaces the old bridge-then-swap 2-step.
   */
  const makeRelayBuyLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        if (!HANDLERS_CONFIGURED) {
          throw new Error("Cross-chain buy is not configured (set NEXT_PUBLIC_BRIDGE_SWAP_HANDLER).");
        }
        await ensureChain(ctx.from.chainId);
        const wallet = (await getWalletClient(wagmiConfig, { chainId: ctx.from.chainId })) as WalletClient;

        // 1. Estimate the USDT that will be delivered to the handler — use the GUARANTEED minimum so
        //    the token floor below stays safe even if the bridge delivers a touch less than quoted.
        const estimate = await getRelayQuote({
          fromChainId: ctx.from.chainId,
          fromCurrency: ctx.from.address,
          toChainId: BSC_CHAIN_ID,
          toCurrency: USDT_BSC.address,
          amount: ctx.amountIn.toString(),
          recipient: BRIDGE_SWAP_HANDLER,
          wallet,
        });
        const minUsdt = relayMinimumOutput(estimate) ?? relayOutputAmount(estimate);
        if (!minUsdt || minUsdt <= 0n) throw new Error("Could not estimate the bridged USDT amount.");

        // 2. Compute the token floor for that USDT via RzSwap's pricing path.
        const { path, amountOut: quotedToken } = await resolveBestBscPath(minUsdt, USDT_BSC.address, ctx.to.address);
        const minOut = applySlippage(quotedToken, ctx.slippageBps);

        // 3. Quote bridge → USDT (to the handler) WITH the fulfill destination call, then execute.
        const fulfillTx = buildBuyFulfillTx({
          swapId: ctx.swapId,
          tokenOut: ctx.to.address,
          minAmountOut: minOut,
          path,
          user: ctx.address,
        });
        const quote = await getRelayQuote({
          fromChainId: ctx.from.chainId,
          fromCurrency: ctx.from.address,
          toChainId: BSC_CHAIN_ID,
          toCurrency: USDT_BSC.address,
          amount: ctx.amountIn.toString(),
          recipient: BRIDGE_SWAP_HANDLER,
          txs: [fulfillTx],
          refundOnOrigin: true,
          wallet,
        });

        let sawTxHash = false;
        try {
          await executeRelay(quote, wallet, (data) => {
            const tx = data.txHashes?.[0];
            if (tx) {
              sawTxHash = true;
              patchLeg(legIndex, { txHash: tx.txHash, chainId: tx.chainId });
            }
          });
        } catch (e) {
          if (!sawTxHash || !isBenignRelaySolverError(e)) throw e;
          patchLeg(legIndex, { note: "Submitted — Relay is bridging and swapping into the token on BNB Chain." });
        }
      },
    [patchLeg],
  );

  // ── prepare ─────────────────────────────────────────────────────────────

  const prepare = useCallback(
    (ctx: SwapContext) => {
      const plan = planSwap(ctx.from, ctx.to);
      ctxRef.current = { intermediate: 0n, usdtBefore: 0n };
      const runners: LegRunner[] = [];
      const legState: RunLeg[] = [];

      if (plan.kind === "local") {
        legState.push({ key: "rzswap", label: `Swap ${ctx.from.symbol} → ${ctx.to.symbol}`, status: "pending", chainId: BSC_CHAIN_ID });
        runners.push(makeRzSwapLeg(ctx, ctx.from, ctx.to, false));
      } else if (plan.kind === "outbound") {
        let idx = 0;
        if (!plan.hubIsEndpoint) {
          legState.push({ key: "rzswap", label: `Swap ${ctx.from.symbol} → USDT`, status: "pending", chainId: BSC_CHAIN_ID });
          runners.push(makeRzSwapLeg(ctx, ctx.from, USDT_BSC, false));
          idx = 1;
        }
        legState.push({ key: "relay", label: `Bridge USDT → ${ctx.to.symbol}`, status: "pending", chainId: BSC_CHAIN_ID });
        runners.push(
          makeRelayLeg(ctx, BSC_CHAIN_ID, USDT_BSC.address, ctx.to.chainId, ctx.to.address, !plan.hubIsEndpoint, false, idx),
        );
      } else if (plan.kind === "inbound") {
        if (plan.hubIsEndpoint) {
          // remote → USDT on BSC, delivered straight to the user. No swap leg.
          legState.push({ key: "relay", label: `Bridge ${ctx.from.symbol} → USDT`, status: "pending", chainId: ctx.from.chainId });
          runners.push(makeRelayLeg(ctx, ctx.from.chainId, ctx.from.address, BSC_CHAIN_ID, USDT_BSC.address, false, false, 0));
        } else {
          // ONE signature: bridge → USDT to the handler + fulfill (swap to token) atomically on BSC.
          legState.push({ key: "buy", label: `Buy ${ctx.to.symbol} (bridge + swap)`, status: "pending", chainId: ctx.from.chainId });
          runners.push(makeRelayBuyLeg(ctx, 0));
        }
      }

      runnersRef.current = runners;
      setLegs(legState);
      setCurrent(0);
    },
    [makeRzSwapLeg, makeRelayLeg, makeRelayBuyLeg],
  );

  // ── auto-run all legs sequentially (one click; wallet prompts in order) ────

  const runFrom = useCallback(
    async (startIndex: number) => {
      setStatus("running");
      for (let i = startIndex; i < runnersRef.current.length; i++) {
        setCurrent(i);
        patchLeg(i, { status: "active", error: undefined });
        try {
          await runnersRef.current[i]();
          patchLeg(i, { status: "done" });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : "Transaction failed";
          patchLeg(i, { status: "error", error: message });
          setStatus("error");
          return;
        }
      }
      setStatus("done");
    },
    [patchLeg],
  );

  /** Builds the legs and runs the whole swap from the first leg. */
  const start = useCallback(
    (ctx: SwapContext) => {
      prepare(ctx);
      void runFrom(0);
    },
    [prepare, runFrom],
  );

  /** Resume from the leg that failed (re-running it). */
  const retry = useCallback(() => {
    void runFrom(current);
  }, [current, runFrom]);

  return { legs, current, status, start, retry, reset };
}
