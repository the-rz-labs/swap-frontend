"use client";

import { useCallback, useRef, useState } from "react";
import { type Address, type WalletClient, encodePacked, encodeFunctionData } from "viem";
import {
  readContract,
  writeContract,
  waitForTransactionReceipt,
  switchChain,
  getWalletClient,
  estimateGas,
  estimateFeesPerGas,
} from "@wagmi/core";
import { wagmiConfig, type AppChainId } from "@/lib/wagmi";
import {
  BSC_CHAIN_ID,
  ETH_CHAIN_ID,
  USDT_BSC,
  USDT_ETH,
  GOLDGR,
  isTronToken,
  isBscToken,
  tokenKey,
  type Token,
} from "@/lib/tokens";
import { isTronAddress, tronBase58ToHex } from "@/lib/tron/tronAddress";
import { tronAdaptedWallet } from "@/lib/tron/tronAdaptedWallet";
import type { RelayWallet } from "@/lib/relay";
import { ERC20_ABI } from "@/lib/rzswap";
import { resolveBestBscPath, resolveBestBscUsdtPath, resolveEthGoldgrPath } from "@/lib/route";
import { getRelayQuote, executeRelay, relayOutputAmount, getRelaySellDeposit, assertBridgeSizeOk } from "@/lib/relay";
import {
  quoteRelayThenGoldgr,
  quoteRelayThenBscToken,
  buildDestFillProbeTxs,
  buildEthDestFillProbeTxs,
} from "@/lib/relayDestFill";
import { isBenignRelaySolverError, friendlyRelayError } from "@/lib/relayErrors";
import { planSwap, applySlippage } from "@/lib/swapPlan";
import {
  buildBuyTxs,
  buildEthBuyTxs,
  buildSellExtraData,
  RZ_GATEWAY,
  RZ_GATEWAY_ABI,
  RELAY_DEPOSIT_ADAPTER,
  GATEWAY_CONFIGURED,
} from "@/lib/gateway";
import { ETH_HUB, ETH_USDT_FILL_ADAPTER, ethHubConfigured, ethBuyFillConfigured, ethSellConfigured, ethGoldgrPath } from "@/lib/hub";

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
  /** Destination address on a non-EVM target chain (e.g. a base58 Tron address) for sell-out. When
   *  the `to` token is non-EVM this is required; for EVM targets the connected `address` is used. */
  destAddress?: string;
  /** Connected source address on a non-EVM origin (e.g. a base58 Tron address) for buy-in. Required
   *  when the `from` token is non-EVM; the matching wallet signs the source transaction. */
  tronAddress?: string;
  /** Correlation id passed to RzSwap.swap and emitted in the Swapped event (for backend matching). */
  swapId: `0x${string}`;
};

type LegRunner = () => Promise<void>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ensures the wallet is on `chainId`, switching if necessary. */
async function ensureChain(chainId: number) {
  await switchChain(wagmiConfig, { chainId: chainId as AppChainId });
  // Dynamic/MetaMask can flip chainId before getWalletClient is rebound — wait briefly.
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

/** Approves `spender` for `amount` of `token` on `chainId` if the current allowance is short. */
// `token` is a BSC (EVM) ERC20 address; callers pass Token.address (typed string for Tron support).
async function ensureAllowance(token: string, owner: Address, spender: Address, amount: bigint, chainId: AppChainId) {
  const address = token as `0x${string}`;
  const current = (await readContract(wagmiConfig, {
    address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
    chainId,
  })) as bigint;
  if (current >= amount) return;

  // Prefill gas/fees via wagmi's public RPC so MetaMask doesn't need eth_estimateGas on a gated RPC.
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
  });
  const [fees, gas] = await Promise.all([
    estimateFeesPerGas(wagmiConfig, { chainId }),
    estimateGas(wagmiConfig, { chainId, account: owner, to: address, data }),
  ]);

  const hash = await writeContract(wagmiConfig, {
    address,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
    chainId,
    account: owner,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
}

/**
 * The signer for the source leg: a Tron WalletConnect AdaptedWallet when paying from Tron, otherwise
 * the connected EVM wallet (after switching it to the source chain).
 */
async function sourceWallet(ctx: SwapContext): Promise<RelayWallet> {
  if (isTronToken(ctx.from)) {
    if (!ctx.tronAddress) throw new Error("Connect your Tron wallet to pay from Tron.");
    return tronAdaptedWallet(ctx.tronAddress);
  }
  await ensureChain(ctx.from.chainId);
  return (await getWalletClient(wagmiConfig, { chainId: ctx.from.chainId as AppChainId })) as WalletClient;
}

async function bscTokenBalance(token: string, owner: Address): Promise<bigint> {
  return (await readContract(wagmiConfig, {
    address: token as `0x${string}`,
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
   * LOCAL leg: BSC tokenIn → tokenOut via RzGateway.swapLocal (1 approve + 1 call). The gateway
   * pulls tokenIn, routes the swap through the RzSwap treasury, and pays tokenOut to the user.
   */
  const makeLocalLeg = useCallback(
    (ctx: SwapContext, tokenIn: Token, tokenOut: Token): LegRunner =>
      async () => {
        if (!GATEWAY_CONFIGURED) throw new Error("Swap is not configured (set NEXT_PUBLIC_RZ_GATEWAY).");
        await ensureChain(BSC_CHAIN_ID);
        const amountIn = ctx.amountIn;
        if (amountIn <= 0n) throw new Error("No input amount available for the swap.");

        const { path, amountOut: quoted } = await resolveBestBscPath(amountIn, tokenIn.address, tokenOut.address);
        const minOut = applySlippage(quoted, ctx.slippageBps);

        await ensureAllowance(tokenIn.address, ctx.address, RZ_GATEWAY, amountIn, BSC_CHAIN_ID);

        const hash = await writeContract(wagmiConfig, {
          address: RZ_GATEWAY,
          abi: RZ_GATEWAY_ABI,
          functionName: "swapLocal",
          args: [ctx.swapId, tokenIn.address as `0x${string}`, tokenOut.address as `0x${string}`, amountIn, minOut, path, ctx.address],
          chainId: BSC_CHAIN_ID,
        });
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: BSC_CHAIN_ID });
      },
    [],
  );

  /** Relay leg between BSC USDT and a remote token, in either direction. */
  const makeRelayLeg = useCallback(
    (
      ctx: SwapContext,
      fromChainId: number,
      fromCurrency: string,
      toChainId: number,
      toCurrency: string,
      useIntermediate: boolean,
      measureBscUsdt: boolean,
      legIndex: number,
    ): LegRunner =>
      async () => {
        const wallet = await sourceWallet(ctx);
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
   * BUY leg (inbound, 1 signature): Relay bridges the user's asset to USDT on BSC and, in the same
   * fill, the Relay router approves RzGateway for the full delivered USDT and calls fulfillBuy
   * (cleanupErc20sViaCall), which swaps it into the target token via the treasury and pays the user.
   * On any failure the gateway delivers USDT to the user instead (fallback).
   */
  const makeRelayBuyLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        if (!GATEWAY_CONFIGURED) {
          throw new Error("Cross-chain buy is not configured (set NEXT_PUBLIC_RZ_GATEWAY).");
        }
        const wallet = await sourceWallet(ctx);

        const { path } = await resolveBestBscUsdtPath(ctx.to.address);
        const probeTxs = buildDestFillProbeTxs({
          swapId: ctx.swapId,
          tokenOut: ctx.to.address as `0x${string}`,
          path,
          user: ctx.address,
        });
        const estimate = await getRelayQuote({
          fromChainId: ctx.from.chainId,
          fromCurrency: ctx.from.address,
          toChainId: BSC_CHAIN_ID,
          toCurrency: USDT_BSC.address,
          amount: ctx.amountIn.toString(),
          recipient: ctx.address,
          txs: probeTxs,
          refundOnOrigin: true,
          wallet,
        });
        const fill = await quoteRelayThenBscToken(estimate, ctx.to, ctx.slippageBps);

        const buyTxs = buildBuyTxs({
          swapId: ctx.swapId,
          tokenOut: ctx.to.address as `0x${string}`,
          minOut: fill.minOutput,
          path: fill.path,
          user: ctx.address,
        });
        const quote = await getRelayQuote({
          fromChainId: ctx.from.chainId,
          fromCurrency: ctx.from.address,
          toChainId: BSC_CHAIN_ID,
          toCurrency: USDT_BSC.address,
          amount: ctx.amountIn.toString(),
          recipient: ctx.address,
          txs: buyTxs,
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

  /**
   * SELL leg (outbound, 1 approve + 1 call): the gateway swaps the user's token → USDT via RzSwap,
   * then RelayDepositAdapter deposits it into Relay to bridge out. The deposit uses Relay's amount-less
   * depositErc20 (see getRelaySellDeposit), so the adapter deposits its FULL balance — the entire swap
   * output is bridged, with NO drift refunded to the user. We still quote Relay with the swap's
   * guaranteed minimum so the destination estimate never over-promises; the swap's `minStableOut`
   * floor keeps the sell fail-safe (under-delivery reverts and the user keeps their token).
   */
  const makeSellLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        if (!GATEWAY_CONFIGURED) {
          throw new Error("Cross-chain sell is not configured (set NEXT_PUBLIC_RZ_GATEWAY).");
        }
        await ensureChain(BSC_CHAIN_ID);

        // Destination recipient: for a non-EVM target (Tron) the user supplies a base58 address; for
        // EVM targets the connected wallet is the recipient. `refundTo` stays the EVM user (refunds
        // happen on BSC). The gateway's `recipient` bytes are informational (emitted only).
        const tronDest = isTronToken(ctx.to);
        if (tronDest && (!ctx.destAddress || !isTronAddress(ctx.destAddress))) {
          throw new Error("Enter a valid Tron (T…) destination address.");
        }
        const relayRecipient = tronDest ? ctx.destAddress! : ctx.address;
        const recipientBytes = tronDest
          ? (tronBase58ToHex(ctx.destAddress!) as `0x${string}`)
          : encodePacked(["address"], [ctx.address]);

        // 1. Quote token → USDT via the treasury.
        const { path, amountOut: expectedUsdt } = await resolveBestBscPath(
          ctx.amountIn,
          ctx.from.address,
          USDT_BSC.address,
        );
        const minUsdt = applySlippage(expectedUsdt, ctx.slippageBps);
        if (minUsdt <= 0n) throw new Error("Swap quote returned zero — try a larger amount.");

        // 2. Relay deposit quote with our adapter as the on-chain depositor. Quote at the EXPECTED
        //    output so the destination estimate matches what's actually bridged (the adapter deposits
        //    its full balance via the amount-less depositErc20, ~= expectedUsdt). The on-chain swap is
        //    still floored at minUsdt, so it fail-safe reverts rather than under-delivering.
        const dep = await getRelaySellDeposit({
          depositor: RELAY_DEPOSIT_ADAPTER,
          refundTo: ctx.address,
          recipient: relayRecipient,
          originCurrency: USDT_BSC.address,
          amount: expectedUsdt.toString(),
          toChainId: ctx.to.chainId,
          toCurrency: ctx.to.address,
        });
        const extraData = buildSellExtraData(dep.depository, ctx.address, dep.data);

        // 3. One approve (token → gateway) + one call (gateway swaps token→USDT and bridges out).
        await ensureAllowance(ctx.from.address, ctx.address, RZ_GATEWAY, ctx.amountIn, BSC_CHAIN_ID);
        const hash = await writeContract(wagmiConfig, {
          address: RZ_GATEWAY,
          abi: RZ_GATEWAY_ABI,
          functionName: "sell",
          args: [
            ctx.swapId,
            ctx.from.address as `0x${string}`,
            ctx.amountIn,
            minUsdt,
            path,
            RELAY_DEPOSIT_ADAPTER,
            BigInt(ctx.to.chainId),
            recipientBytes,
            extraData,
          ],
          value: BigInt(dep.value || "0"),
          chainId: BSC_CHAIN_ID,
        });
        patchLeg(legIndex, { txHash: hash, chainId: BSC_CHAIN_ID });
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: BSC_CHAIN_ID });
      },
    [patchLeg],
  );

  // ── GOLDGR legs (ETH hub) — only wired when plan.kind is a GOLDGR kind ──

  /** LOCAL ETH: USDT ↔ GOLDGR via ETH RzGateway.swapLocal. */
  const makeLocalEthLeg = useCallback(
    (ctx: SwapContext): LegRunner =>
      async () => {
        if (!ethHubConfigured()) throw new Error("ETH GOLDGR hub is not configured.");
        await ensureChain(ETH_CHAIN_ID);
        const amountIn = ctx.amountIn;
        if (amountIn <= 0n) throw new Error("No input amount available for the swap.");

        const { path, amountOut: quoted } = await resolveEthGoldgrPath(amountIn, ctx.from, ctx.to);
        const minOut = applySlippage(quoted, ctx.slippageBps);

        await ensureAllowance(ctx.from.address, ctx.address, ETH_HUB.gateway, amountIn, ETH_CHAIN_ID);

        const hash = await writeContract(wagmiConfig, {
          address: ETH_HUB.gateway,
          abi: RZ_GATEWAY_ABI,
          functionName: "swapLocal",
          args: [
            ctx.swapId,
            ctx.from.address as `0x${string}`,
            ctx.to.address as `0x${string}`,
            amountIn,
            minOut,
            path,
            ctx.address,
          ],
          chainId: ETH_CHAIN_ID,
        });
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: ETH_CHAIN_ID });
      },
    [],
  );

  /**
   * BUY GOLDGR: Relay → USDT(ETH) + EthUsdtFillAdapter → fulfillBuy.
   * Uses cleanupErc20s (safeTransfer) — not cleanupErc20sViaCall (broken on mainnet USDT).
   */
  const makeRelayBuyGoldgrLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        if (!ethBuyFillConfigured()) {
          throw new Error(
            "ETH GOLDGR buy is not configured — set NEXT_PUBLIC_ETH_USDT_FILL_ADAPTER (and ETH gateway/vault).",
          );
        }
        const wallet = await sourceWallet(ctx);

        const path = ethGoldgrPath(USDT_ETH, GOLDGR);
        const probeTxs = buildEthDestFillProbeTxs({
          swapId: ctx.swapId,
          tokenOut: GOLDGR.address as `0x${string}`,
          path,
          user: ctx.address,
          usdt: USDT_ETH.address as `0x${string}`,
          fillAdapter: ETH_USDT_FILL_ADAPTER,
        });
        const estimate = await getRelayQuote({
          fromChainId: ctx.from.chainId,
          fromCurrency: ctx.from.address,
          toChainId: ETH_CHAIN_ID,
          toCurrency: USDT_ETH.address,
          amount: ctx.amountIn.toString(),
          recipient: ctx.address,
          txs: probeTxs,
          refundOnOrigin: true,
          wallet,
        });
        assertBridgeSizeOk(estimate, "GOLDGR buy");
        const fill = await quoteRelayThenGoldgr(estimate, ctx.slippageBps);

        const buyTxs = buildEthBuyTxs({
          swapId: ctx.swapId,
          tokenOut: GOLDGR.address as `0x${string}`,
          minOut: fill.minOutput,
          path: fill.path,
          user: ctx.address,
          usdt: USDT_ETH.address as `0x${string}`,
          fillAdapter: ETH_USDT_FILL_ADAPTER,
        });
        const quote = await getRelayQuote({
          fromChainId: ctx.from.chainId,
          fromCurrency: ctx.from.address,
          toChainId: ETH_CHAIN_ID,
          toCurrency: USDT_ETH.address,
          amount: ctx.amountIn.toString(),
          recipient: ctx.address,
          txs: buyTxs,
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
          patchLeg(legIndex, { note: "Submitted — Relay is bridging and swapping into GOLDGR on Ethereum." });
        }
      },
    [patchLeg],
  );

  /**
   * SELL GOLDGR from ETH: swap GOLDGR→USDT then adapter bridges out.
   * When destination is a BSC ecosystem token, attach BSC fulfillBuy txs.
   */
  const makeSellGoldgrLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        if (!ethSellConfigured()) {
          throw new Error(
            "GOLDGR sell is not configured — set NEXT_PUBLIC_ETH_RELAY_DEPOSIT_ADAPTER and NEXT_PUBLIC_ETH_RELAY_DEPOSITORY.",
          );
        }
        await ensureChain(ETH_CHAIN_ID);

        const tronDest = isTronToken(ctx.to);
        if (tronDest && (!ctx.destAddress || !isTronAddress(ctx.destAddress))) {
          throw new Error("Enter a valid Tron (T…) destination address.");
        }
        const relayRecipient = tronDest ? ctx.destAddress! : ctx.address;
        const recipientBytes = tronDest
          ? (tronBase58ToHex(ctx.destAddress!) as `0x${string}`)
          : encodePacked(["address"], [ctx.address]);

        const { path, amountOut: expectedUsdt } = await resolveEthGoldgrPath(ctx.amountIn, GOLDGR, USDT_ETH);
        const minUsdt = applySlippage(expectedUsdt, ctx.slippageBps);
        if (minUsdt <= 0n) throw new Error("Swap quote returned zero — try a larger amount.");

        const destIsBscToken = isBscToken(ctx.to) && tokenKey(ctx.to) !== tokenKey(USDT_BSC);
        let toChainId = ctx.to.chainId;
        let toCurrency = ctx.to.address;
        let txs: ReturnType<typeof buildBuyTxs> | undefined;

        if (destIsBscToken) {
          const { path: bscPath } = await resolveBestBscUsdtPath(ctx.to.address);
          const probeTxs = buildDestFillProbeTxs({
            swapId: ctx.swapId,
            tokenOut: ctx.to.address as `0x${string}`,
            path: bscPath,
            user: ctx.address,
          });
          const minUsdtBscEstimate = await getRelayQuote({
            fromChainId: ETH_CHAIN_ID,
            fromCurrency: USDT_ETH.address,
            toChainId: BSC_CHAIN_ID,
            toCurrency: USDT_BSC.address,
            amount: expectedUsdt.toString(),
            recipient: ctx.address,
            txs: probeTxs,
            refundOnOrigin: true,
          });
          assertBridgeSizeOk(minUsdtBscEstimate, "GOLDGR sell");
          const fill = await quoteRelayThenBscToken(minUsdtBscEstimate, ctx.to, ctx.slippageBps);
          txs = buildBuyTxs({
            swapId: ctx.swapId,
            tokenOut: ctx.to.address as `0x${string}`,
            minOut: fill.minOutput,
            path: fill.path,
            user: ctx.address,
          });
          toChainId = BSC_CHAIN_ID;
          toCurrency = USDT_BSC.address;
        }

        const dep = await getRelaySellDeposit({
          depositor: ETH_HUB.adapter,
          refundTo: ctx.address,
          recipient: relayRecipient,
          originCurrency: USDT_ETH.address,
          amount: expectedUsdt.toString(),
          toChainId,
          toCurrency,
          originChainId: ETH_CHAIN_ID,
          txs,
        });
        const extraData = buildSellExtraData(dep.depository, ctx.address, dep.data);

        await ensureAllowance(GOLDGR.address, ctx.address, ETH_HUB.gateway, ctx.amountIn, ETH_CHAIN_ID);
        const hash = await writeContract(wagmiConfig, {
          address: ETH_HUB.gateway,
          abi: RZ_GATEWAY_ABI,
          functionName: "sell",
          args: [
            ctx.swapId,
            GOLDGR.address as `0x${string}`,
            ctx.amountIn,
            minUsdt,
            path,
            ETH_HUB.adapter,
            BigInt(toChainId),
            recipientBytes,
            extraData,
          ],
          value: BigInt(dep.value || "0"),
          chainId: ETH_CHAIN_ID,
        });
        patchLeg(legIndex, { txHash: hash, chainId: ETH_CHAIN_ID });
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: ETH_CHAIN_ID });
      },
    [patchLeg],
  );

  /**
   * BSC ecosystem → GOLDGR: BSC sell (token→USDT) + Relay → USDT(ETH) + ETH fulfillBuy.
   * One approve + one BSC `sell` call; no user ETH signature.
   */
  const makeBscToGoldgrLeg = useCallback(
    (ctx: SwapContext, legIndex: number): LegRunner =>
      async () => {
        if (!GATEWAY_CONFIGURED) throw new Error("BSC gateway is not configured.");
        if (!ethBuyFillConfigured()) {
          throw new Error(
            "ETH GOLDGR buy is not configured — set NEXT_PUBLIC_ETH_USDT_FILL_ADAPTER (and ETH gateway/vault).",
          );
        }
        await ensureChain(BSC_CHAIN_ID);

        const { path, amountOut: expectedUsdt } = await resolveBestBscPath(
          ctx.amountIn,
          ctx.from.address,
          USDT_BSC.address,
        );
        const minUsdt = applySlippage(expectedUsdt, ctx.slippageBps);
        if (minUsdt <= 0n) throw new Error("Swap quote returned zero — try a larger amount.");

        const ethPath = ethGoldgrPath(USDT_ETH, GOLDGR);
        const probeTxs = buildEthDestFillProbeTxs({
          swapId: ctx.swapId,
          tokenOut: GOLDGR.address as `0x${string}`,
          path: ethPath,
          user: ctx.address,
          usdt: USDT_ETH.address as `0x${string}`,
          fillAdapter: ETH_USDT_FILL_ADAPTER,
        });
        const bridgeEst = await getRelayQuote({
          fromChainId: BSC_CHAIN_ID,
          fromCurrency: USDT_BSC.address,
          toChainId: ETH_CHAIN_ID,
          toCurrency: USDT_ETH.address,
          amount: expectedUsdt.toString(),
          recipient: ctx.address,
          txs: probeTxs,
          refundOnOrigin: true,
        });
        assertBridgeSizeOk(bridgeEst, "GOLDGR buy");
        const fill = await quoteRelayThenGoldgr(bridgeEst, ctx.slippageBps);

        const buyTxs = buildEthBuyTxs({
          swapId: ctx.swapId,
          tokenOut: GOLDGR.address as `0x${string}`,
          minOut: fill.minOutput,
          path: fill.path,
          user: ctx.address,
          usdt: USDT_ETH.address as `0x${string}`,
          fillAdapter: ETH_USDT_FILL_ADAPTER,
        });

        const dep = await getRelaySellDeposit({
          depositor: RELAY_DEPOSIT_ADAPTER,
          refundTo: ctx.address,
          recipient: ctx.address,
          originCurrency: USDT_BSC.address,
          amount: expectedUsdt.toString(),
          toChainId: ETH_CHAIN_ID,
          toCurrency: USDT_ETH.address,
          originChainId: BSC_CHAIN_ID,
          txs: buyTxs,
        });
        const extraData = buildSellExtraData(dep.depository, ctx.address, dep.data);
        const recipientBytes = encodePacked(["address"], [ctx.address]);

        await ensureAllowance(ctx.from.address, ctx.address, RZ_GATEWAY, ctx.amountIn, BSC_CHAIN_ID);
        const hash = await writeContract(wagmiConfig, {
          address: RZ_GATEWAY,
          abi: RZ_GATEWAY_ABI,
          functionName: "sell",
          args: [
            ctx.swapId,
            ctx.from.address as `0x${string}`,
            ctx.amountIn,
            minUsdt,
            path,
            RELAY_DEPOSIT_ADAPTER,
            BigInt(ETH_CHAIN_ID),
            recipientBytes,
            extraData,
          ],
          value: BigInt(dep.value || "0"),
          chainId: BSC_CHAIN_ID,
        });
        patchLeg(legIndex, { txHash: hash, chainId: BSC_CHAIN_ID });
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: BSC_CHAIN_ID });
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
        legState.push({ key: "local", label: `Swap ${ctx.from.symbol} → ${ctx.to.symbol}`, status: "pending", chainId: BSC_CHAIN_ID });
        runners.push(makeLocalLeg(ctx, ctx.from, ctx.to));
      } else if (plan.kind === "outbound") {
        if (plan.hubIsEndpoint) {
          // USDT (BSC) → remote: a plain Relay bridge (user deposits USDT directly).
          legState.push({ key: "relay", label: `Bridge USDT → ${ctx.to.symbol}`, status: "pending", chainId: BSC_CHAIN_ID });
          runners.push(makeRelayLeg(ctx, BSC_CHAIN_ID, USDT_BSC.address, ctx.to.chainId, ctx.to.address, false, false, 0));
        } else {
          // ONE approve + ONE call: SellHandler swaps token→USDT and bridges out in a single tx.
          legState.push({ key: "sell", label: `Sell ${ctx.from.symbol} → ${ctx.to.symbol}`, status: "pending", chainId: BSC_CHAIN_ID });
          runners.push(makeSellLeg(ctx, 0));
        }
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
      } else if (plan.kind === "local-eth") {
        legState.push({
          key: "local-eth",
          label: `Swap ${ctx.from.symbol} → ${ctx.to.symbol}`,
          status: "pending",
          chainId: ETH_CHAIN_ID,
        });
        runners.push(makeLocalEthLeg(ctx));
      } else if (plan.kind === "buy-goldgr") {
        legState.push({
          key: "buy-goldgr",
          label: `Buy GOLDGR (bridge + swap)`,
          status: "pending",
          chainId: ctx.from.chainId,
        });
        runners.push(makeRelayBuyGoldgrLeg(ctx, 0));
      } else if (plan.kind === "sell-goldgr") {
        legState.push({
          key: "sell-goldgr",
          label: `Sell GOLDGR → ${ctx.to.symbol}`,
          status: "pending",
          chainId: ETH_CHAIN_ID,
        });
        runners.push(makeSellGoldgrLeg(ctx, 0));
      } else if (plan.kind === "bsc-to-goldgr") {
        legState.push({
          key: "bsc-to-goldgr",
          label: `Sell ${ctx.from.symbol} → GOLDGR`,
          status: "pending",
          chainId: BSC_CHAIN_ID,
        });
        runners.push(makeBscToGoldgrLeg(ctx, 0));
      }

      runnersRef.current = runners;
      setLegs(legState);
      setCurrent(0);
    },
    [
      makeLocalLeg,
      makeRelayLeg,
      makeRelayBuyLeg,
      makeSellLeg,
      makeLocalEthLeg,
      makeRelayBuyGoldgrLeg,
      makeSellGoldgrLeg,
      makeBscToGoldgrLeg,
    ],
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
