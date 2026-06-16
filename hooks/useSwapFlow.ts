"use client";

import { useCallback, useRef, useState } from "react";
import type { Address, WalletClient } from "viem";
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
import { getRelayQuote, executeRelay, relayOutputAmount } from "@/lib/relay";
import { planSwap, applySlippage } from "@/lib/swapPlan";

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
};

type LegRunner = () => Promise<void>;

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
  const ctxRef = useRef<{ intermediate: bigint }>({ intermediate: 0n });

  const patchLeg = useCallback((index: number, patch: Partial<RunLeg>) => {
    setLegs((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }, []);

  const reset = useCallback(() => {
    runnersRef.current = [];
    ctxRef.current = { intermediate: 0n };
    setLegs([]);
    setCurrent(0);
    setStatus("idle");
  }, []);

  // ── leg builders ────────────────────────────────────────────────────────

  /** RzSwap leg: tokenIn → tokenOut on BSC. `useIntermediate` uses the measured hub amount. */
  const makeRzSwapLeg = useCallback(
    (ctx: SwapContext, tokenIn: Token, tokenOut: Token, useIntermediate: boolean): LegRunner =>
      async () => {
        await ensureChain(BSC_CHAIN_ID);
        const amountIn = useIntermediate ? ctxRef.current.intermediate : ctx.amountIn;
        if (amountIn <= 0n) throw new Error("No input amount available for the on-chain swap.");

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

        const before = measureBscUsdt ? await bscTokenBalance(USDT_BSC.address, ctx.address) : 0n;

        const quote = await getRelayQuote({
          fromChainId,
          fromCurrency,
          toChainId,
          toCurrency,
          amount: amount.toString(),
          recipient: ctx.address,
          wallet,
        });

        await executeRelay(quote, wallet, (data) => {
          const tx = data.txHashes?.[0];
          if (tx) patchLeg(legIndex, { txHash: tx.txHash, chainId: tx.chainId });
        });

        if (measureBscUsdt) {
          const after = await bscTokenBalance(USDT_BSC.address, ctx.address);
          const delta = after > before ? after - before : relayOutputAmount(quote) ?? 0n;
          ctxRef.current.intermediate = delta;
        }
      },
    [patchLeg],
  );

  // ── prepare ─────────────────────────────────────────────────────────────

  const prepare = useCallback(
    (ctx: SwapContext) => {
      const plan = planSwap(ctx.from, ctx.to);
      ctxRef.current = { intermediate: 0n };
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
        legState.push({ key: "relay", label: `Bridge ${ctx.from.symbol} → USDT`, status: "pending", chainId: ctx.from.chainId });
        runners.push(makeRelayLeg(ctx, ctx.from.chainId, ctx.from.address, BSC_CHAIN_ID, USDT_BSC.address, false, true, 0));
        if (!plan.hubIsEndpoint) {
          legState.push({ key: "rzswap", label: `Swap USDT → ${ctx.to.symbol}`, status: "pending", chainId: BSC_CHAIN_ID });
          runners.push(makeRzSwapLeg(ctx, USDT_BSC, ctx.to, true));
        }
      }

      runnersRef.current = runners;
      setLegs(legState);
      setCurrent(0);
      setStatus(legState.length > 0 ? "awaiting" : "idle");
    },
    [makeRzSwapLeg, makeRelayLeg],
  );

  // ── run the current leg ──────────────────────────────────────────────────

  const confirmNext = useCallback(async () => {
    const index = current;
    const runner = runnersRef.current[index];
    if (!runner) return;

    setStatus("running");
    patchLeg(index, { status: "active", error: undefined });
    try {
      await runner();
      patchLeg(index, { status: "done" });
      const next = index + 1;
      if (next >= runnersRef.current.length) {
        setStatus("done");
      } else {
        setCurrent(next);
        setStatus("awaiting");
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Transaction failed";
      patchLeg(index, { status: "error", error: message });
      setStatus("error");
    }
  }, [current, patchLeg]);

  /** Re-run the current (failed) leg. */
  const retry = useCallback(async () => {
    patchLeg(current, { status: "pending", error: undefined });
    setStatus("awaiting");
  }, [current, patchLeg]);

  return { legs, current, status, prepare, confirmNext, retry, reset };
}
