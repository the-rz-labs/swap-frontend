"use client";

import { useCallback, useRef, useState } from "react";
import { type Address, type Hex, type WalletClient } from "viem";
import { switchChain, getWalletClient, waitForTransactionReceipt } from "@wagmi/core";
import { wagmiConfig, type AppChainId } from "@/lib/wagmi";
import { USDT_TRON_ADDRESS, isTronToken, type Token } from "@/lib/tokens";
import { isTronAddress } from "@/lib/tron/tronAddress";
import { tronAdaptedWallet } from "@/lib/tron/tronAdaptedWallet";
import type { RelayWallet } from "@/lib/relay";
import { getRelayQuote, executeRelay } from "@/lib/relay";
import { isBenignRelaySolverError, friendlyRelayError } from "@/lib/relayErrors";
import { planSwap } from "@/lib/swapPlan";
import { ensureErc20Allowance, type QuoteProvider } from "@/lib/relayQuote";
import { getSushiSwap } from "@/lib/sushi";
import { getLifiSwap } from "@/lib/lifi";

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
  destAddress?: string;
  tronAddress?: string;
  provider?: QuoteProvider;
};

type LegRunner = () => Promise<void>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureChain(chainId: number) {
  await switchChain(wagmiConfig, { chainId: chainId as AppChainId });
  for (let i = 0; i < 15; i++) {
    const client = await getWalletClient(wagmiConfig, { chainId: chainId as AppChainId });
    if (client) {
      try {
        if ((await client.getChainId()) === chainId) return;
      } catch {
        /* retry */
      }
    }
    await sleep(100);
  }
}

function relayRecipient(ctx: SwapContext): string {
  if (isTronToken(ctx.to)) {
    if (!ctx.destAddress || !isTronAddress(ctx.destAddress)) {
      throw new Error("Enter a valid Tron (T…) destination address.");
    }
    return ctx.destAddress;
  }
  return ctx.address;
}

async function sourceWallet(ctx: SwapContext): Promise<RelayWallet> {
  if (isTronToken(ctx.from)) {
    if (!ctx.tronAddress) throw new Error("Connect your Tron wallet to pay from Tron.");
    return tronAdaptedWallet(ctx.tronAddress);
  }
  await ensureChain(ctx.from.chainId);
  return (await getWalletClient(wagmiConfig, { chainId: ctx.from.chainId as AppChainId })) as WalletClient;
}

function providerLabel(provider: QuoteProvider, from: Token, to: Token, fallbackDetail: string): {
  key: string;
  label: string;
  note: string;
} {
  if (provider === "sushi") {
    return {
      key: "sushi",
      label: "Swap via Sushi",
      note: `${from.symbol} → ${to.symbol} via Sushi`,
    };
  }
  if (provider === "lifi") {
    return {
      key: "lifi",
      label: "Bridge via LI.FI",
      note: `${from.symbol} → ${to.symbol} via LI.FI`,
    };
  }
  return { key: "relay", label: "Swap via Relay", note: fallbackDetail };
}

/**
 * Single-leg swap: Relay, same-chain Sushi, or cross-chain LI.FI — whichever won the quote race.
 */
export function useSwapFlow() {
  const [legs, setLegs] = useState<RunLeg[]>([]);
  const [current, setCurrent] = useState(0);
  const [status, setStatus] = useState<FlowStatus>("idle");

  const runnersRef = useRef<LegRunner[]>([]);

  const patchLeg = useCallback((index: number, patch: Partial<RunLeg>) => {
    setLegs((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }, []);

  const reset = useCallback(() => {
    runnersRef.current = [];
    setLegs([]);
    setCurrent(0);
    setStatus("idle");
  }, []);

  const makeRelayLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        const wallet = await sourceWallet(ctx);
        if (ctx.amountIn <= 0n) throw new Error("No input amount available for the swap.");

        const quote = await getRelayQuote({
          fromChainId: ctx.from.chainId,
          fromCurrency: ctx.from.address,
          toChainId: ctx.to.chainId,
          toCurrency: ctx.to.address,
          amount: ctx.amountIn.toString(),
          recipient: relayRecipient(ctx),
          user: isTronToken(ctx.from) ? USDT_TRON_ADDRESS : undefined,
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
          patchLeg(legIndex, { note: "Submitted — Relay is confirming your swap." });
        }
      },
    [patchLeg],
  );

  const makeSushiLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        if (isTronToken(ctx.from) || isTronToken(ctx.to)) {
          throw new Error("Sushi swaps are EVM-only.");
        }
        if (ctx.from.chainId !== ctx.to.chainId) {
          throw new Error("Sushi is only used for same-chain swaps.");
        }
        if (ctx.amountIn <= 0n) throw new Error("No input amount available for the swap.");

        await ensureChain(ctx.from.chainId);
        const wallet = (await getWalletClient(wagmiConfig, {
          chainId: ctx.from.chainId as AppChainId,
        })) as WalletClient;
        if (!wallet?.account) throw new Error("Connect an EVM wallet to swap via Sushi.");

        const { tx } = await getSushiSwap({
          chainId: ctx.from.chainId,
          tokenIn: ctx.from.address,
          tokenOut: ctx.to.address,
          amount: ctx.amountIn,
          slippageBps: ctx.slippageBps,
          sender: wallet.account.address,
        });

        await ensureErc20Allowance(wallet, ctx.from, tx.to, ctx.amountIn);

        const hash = await wallet.sendTransaction({
          account: wallet.account,
          chain: wallet.chain,
          to: tx.to,
          data: tx.data as Hex,
          value: tx.value,
        });
        patchLeg(legIndex, { txHash: hash, chainId: ctx.from.chainId });
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: ctx.from.chainId as AppChainId });
      },
    [patchLeg],
  );

  const makeLifiLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        if (isTronToken(ctx.from) || isTronToken(ctx.to)) {
          throw new Error("LI.FI path is EVM-only in this app.");
        }
        if (ctx.from.chainId === ctx.to.chainId) {
          throw new Error("LI.FI path is for cross-chain swaps.");
        }
        if (ctx.amountIn <= 0n) throw new Error("No input amount available for the swap.");

        await ensureChain(ctx.from.chainId);
        const wallet = (await getWalletClient(wagmiConfig, {
          chainId: ctx.from.chainId as AppChainId,
        })) as WalletClient;
        if (!wallet?.account) throw new Error("Connect an EVM wallet to swap via LI.FI.");

        const toAddress = ctx.address;
        const { tx } = await getLifiSwap({
          fromChainId: ctx.from.chainId,
          toChainId: ctx.to.chainId,
          fromToken: ctx.from.address,
          toToken: ctx.to.address,
          amount: ctx.amountIn,
          slippageBps: ctx.slippageBps,
          fromAddress: wallet.account.address,
          toAddress,
        });

        await ensureErc20Allowance(wallet, ctx.from, tx.to, ctx.amountIn);

        const hash = await wallet.sendTransaction({
          account: wallet.account,
          chain: wallet.chain,
          to: tx.to,
          data: tx.data as Hex,
          value: tx.value,
        });
        patchLeg(legIndex, {
          txHash: hash,
          chainId: ctx.from.chainId,
          note: "Source tx submitted — LI.FI is bridging to destination.",
        });
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: ctx.from.chainId as AppChainId });
      },
    [patchLeg],
  );

  const prepare = useCallback(
    (ctx: SwapContext) => {
      const plan = planSwap(ctx.from, ctx.to);
      const runners: LegRunner[] = [];
      const legState: RunLeg[] = [];
      const provider: QuoteProvider = ctx.provider ?? "relay";

      if (plan.kind === "relay" && plan.legs[0]) {
        const meta = providerLabel(provider, ctx.from, ctx.to, plan.legs[0].detail);
        legState.push({
          key: meta.key,
          label: meta.label,
          status: "pending",
          chainId: ctx.from.chainId,
          note: meta.note,
        });
        if (provider === "sushi") runners.push(makeSushiLeg(ctx, 0));
        else if (provider === "lifi") runners.push(makeLifiLeg(ctx, 0));
        else runners.push(makeRelayLeg(ctx, 0));
      }

      runnersRef.current = runners;
      setLegs(legState);
      setCurrent(0);
    },
    [makeRelayLeg, makeSushiLeg, makeLifiLeg],
  );

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
          const message = e instanceof Error ? friendlyRelayError(e) : "Transaction failed";
          patchLeg(i, { status: "error", error: message });
          setStatus("error");
          return;
        }
      }
      setStatus("done");
    },
    [patchLeg],
  );

  const start = useCallback(
    (ctx: SwapContext) => {
      prepare(ctx);
      void runFrom(0);
    },
    [prepare, runFrom],
  );

  const retry = useCallback(() => {
    void runFrom(current);
  }, [current, runFrom]);

  return { legs, current, status, start, retry, reset };
}
