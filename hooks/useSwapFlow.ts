"use client";

import { useCallback, useRef, useState } from "react";
import { type Address, type WalletClient } from "viem";
import { switchChain, getWalletClient } from "@wagmi/core";
import { wagmiConfig, type AppChainId } from "@/lib/wagmi";
import { USDT_TRON_ADDRESS, isTronToken, type Token } from "@/lib/tokens";
import { isTronAddress } from "@/lib/tron/tronAddress";
import { tronAdaptedWallet } from "@/lib/tron/tronAdaptedWallet";
import type { RelayWallet } from "@/lib/relay";
import { getRelayQuote, executeRelay } from "@/lib/relay";
import { isBenignRelaySolverError, friendlyRelayError } from "@/lib/relayErrors";
import { planSwap } from "@/lib/swapPlan";

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
  /** Connected EVM wallet (source refunds, EVM destinations). */
  address: Address;
  /** Destination address on a non-EVM target chain (e.g. base58 Tron) when `to` is non-EVM. */
  destAddress?: string;
  /** Connected source address on a non-EVM origin when paying from Tron. */
  tronAddress?: string;
};

type LegRunner = () => Promise<void>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ensures the wallet is on `chainId`, switching if necessary. */
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

/** Relay destination recipient — Tron uses `destAddress`; EVM uses the connected wallet. */
function relayRecipient(ctx: SwapContext): string {
  if (isTronToken(ctx.to)) {
    if (!ctx.destAddress || !isTronAddress(ctx.destAddress)) {
      throw new Error("Enter a valid Tron (T…) destination address.");
    }
    return ctx.destAddress;
  }
  return ctx.address;
}

/**
 * Signer for the source leg: Tron AdaptedWallet when paying from Tron, otherwise the EVM wallet
 * (after switching to the source chain).
 */
async function sourceWallet(ctx: SwapContext): Promise<RelayWallet> {
  if (isTronToken(ctx.from)) {
    if (!ctx.tronAddress) throw new Error("Connect your Tron wallet to pay from Tron.");
    return tronAdaptedWallet(ctx.tronAddress);
  }
  await ensureChain(ctx.from.chainId);
  return (await getWalletClient(wagmiConfig, { chainId: ctx.from.chainId as AppChainId })) as WalletClient;
}

/**
 * Drives a swap as a single Relay execute leg. Quotes and executes through Relay only — no custom
 * dest txs, no gateway writes.
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

  const prepare = useCallback(
    (ctx: SwapContext) => {
      const plan = planSwap(ctx.from, ctx.to);
      const runners: LegRunner[] = [];
      const legState: RunLeg[] = [];

      if (plan.kind === "relay" && plan.legs[0]) {
        const leg = plan.legs[0];
        legState.push({
          key: "relay",
          label: leg.title,
          status: "pending",
          chainId: ctx.from.chainId,
          note: leg.detail,
        });
        runners.push(makeRelayLeg(ctx, 0));
      }

      runnersRef.current = runners;
      setLegs(legState);
      setCurrent(0);
    },
    [makeRelayLeg],
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
