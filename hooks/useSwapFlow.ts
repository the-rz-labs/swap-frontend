"use client";

import { useCallback, useRef, useState } from "react";
import { getAddress, type Address, type Hex, type WalletClient } from "viem";
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
import { getKyberSwap } from "@/lib/kyber";
import { getFlySwap } from "@/lib/fly";
import { getLifiSwap, isLifiTronChain } from "@/lib/lifi";
import { getTronSigner } from "@/lib/tron/tronDynamic";
import { ensureTrc20Allowance, sendTronContractCall, waitForTronReceipt } from "@/lib/tron/tronGrid";

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
  if (provider === "kyber") {
    return {
      key: "kyber",
      label: "Swap via KyberSwap",
      note: `${from.symbol} → ${to.symbol} via KyberSwap`,
    };
  }
  if (provider === "fly") {
    return {
      key: "fly",
      label: "Swap via Fly",
      note: `${from.symbol} → ${to.symbol} via Fly`,
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
 * Single-leg swap: Relay, local aggregators, or cross-chain LI.FI — whichever won the quote race.
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

  const makeKyberLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        if (isTronToken(ctx.from) || isTronToken(ctx.to)) {
          throw new Error("KyberSwap is EVM-only.");
        }
        if (ctx.from.chainId !== ctx.to.chainId) {
          throw new Error("KyberSwap is only used for same-chain swaps.");
        }
        if (ctx.amountIn <= 0n) throw new Error("No input amount available for the swap.");

        await ensureChain(ctx.from.chainId);
        const wallet = (await getWalletClient(wagmiConfig, {
          chainId: ctx.from.chainId as AppChainId,
        })) as WalletClient;
        if (!wallet?.account) throw new Error("Connect an EVM wallet to swap via KyberSwap.");

        const { tx } = await getKyberSwap({
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

  const makeFlyLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        if (isTronToken(ctx.from) || isTronToken(ctx.to)) {
          throw new Error("Fly is EVM-only.");
        }
        if (ctx.from.chainId !== ctx.to.chainId) {
          throw new Error("Fly is only used for same-chain swaps.");
        }
        if (ctx.amountIn <= 0n) throw new Error("No input amount available for the swap.");

        await ensureChain(ctx.from.chainId);
        const wallet = (await getWalletClient(wagmiConfig, {
          chainId: ctx.from.chainId as AppChainId,
        })) as WalletClient;
        if (!wallet?.account) throw new Error("Connect an EVM wallet to swap via Fly.");

        const { tx } = await getFlySwap({
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
        if (ctx.from.chainId === ctx.to.chainId) {
          throw new Error("LI.FI path is for cross-chain swaps.");
        }
        if (ctx.amountIn <= 0n) throw new Error("No input amount available for the swap.");

        const toAddress = isTronToken(ctx.to)
          ? relayRecipient(ctx)
          : ctx.address;

        // --- Tron source (buy from Tron): TRC-20 approve + TriggerSmartContract ---
        if (isTronToken(ctx.from)) {
          if (!ctx.tronAddress || !isTronAddress(ctx.tronAddress)) {
            throw new Error("Connect your Tron wallet to swap via LI.FI.");
          }
          const signer = getTronSigner();
          if (!signer) throw new Error("No Tron wallet connected to sign the source transaction.");

          const { tx, approvalAddress } = await getLifiSwap({
            fromChainId: ctx.from.chainId,
            toChainId: ctx.to.chainId,
            fromToken: ctx.from.address,
            toToken: ctx.to.address,
            amount: ctx.amountIn,
            slippageBps: ctx.slippageBps,
            fromAddress: ctx.tronAddress,
            toAddress,
          });
          if (!isLifiTronChain(tx.chainId) && !isTronAddress(tx.to)) {
            throw new Error("LI.FI returned a non-Tron source transaction for a Tron sell.");
          }

          const spender = approvalAddress ?? tx.to;
          if (spender) {
            await ensureTrc20Allowance({
              ownerBase58: ctx.tronAddress,
              tokenBase58: ctx.from.address,
              spenderBase58: spender,
              amount: ctx.amountIn,
              sign: (t) => signer.sign(t),
            });
          }

          const txid = await sendTronContractCall({
            ownerBase58: ctx.tronAddress,
            contractBase58: tx.to,
            data: tx.data,
            callValue: tx.value != null && tx.value > 0n ? Number(tx.value) : 0,
            sign: (t) => signer.sign(t),
          });
          patchLeg(legIndex, {
            txHash: txid,
            chainId: ctx.from.chainId,
            note: "Source tx submitted — LI.FI is bridging to destination.",
          });
          await waitForTronReceipt(txid);
          return;
        }

        // --- EVM source (incl. sell to Tron): approve + sendTransaction ---
        await ensureChain(ctx.from.chainId);
        const wallet = (await getWalletClient(wagmiConfig, {
          chainId: ctx.from.chainId as AppChainId,
        })) as WalletClient;
        if (!wallet?.account) throw new Error("Connect an EVM wallet to swap via LI.FI.");

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
        if (isTronAddress(tx.to) || isLifiTronChain(tx.chainId)) {
          throw new Error("LI.FI returned a Tron source tx for an EVM wallet.");
        }

        const spender = getAddress(tx.to as Address);
        await ensureErc20Allowance(wallet, ctx.from, spender, ctx.amountIn);

        const hash = await wallet.sendTransaction({
          account: wallet.account,
          chain: wallet.chain,
          to: spender,
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
        else if (provider === "kyber") runners.push(makeKyberLeg(ctx, 0));
        else if (provider === "fly") runners.push(makeFlyLeg(ctx, 0));
        else if (provider === "lifi") runners.push(makeLifiLeg(ctx, 0));
        else runners.push(makeRelayLeg(ctx, 0));
      }

      runnersRef.current = runners;
      setLegs(legState);
      setCurrent(0);
    },
    [makeRelayLeg, makeSushiLeg, makeKyberLeg, makeFlyLeg, makeLifiLeg],
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
