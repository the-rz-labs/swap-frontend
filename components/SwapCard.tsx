"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppKit, useAppKitAccount } from "@reown/appkit/react";
import { BSC_TOKENS, REMOTE_TOKENS, USDT_BSC, isBscToken, tokenKey, type Token } from "@/lib/tokens";
import { RZSWAP_CONFIGURED } from "@/lib/rzswap";
import { planSwap, applySlippage } from "@/lib/swapPlan";
import { safeParseUnits, formatAmount } from "@/lib/format";
import { useQuote } from "@/hooks/useQuote";
import { useSwapFlow } from "@/hooks/useSwapFlow";
import { TokenSelector } from "./TokenSelector";
import { StepTracker } from "./StepTracker";

const ALL_TOKENS: Token[] = [...BSC_TOKENS, ...REMOTE_TOKENS];
const SLIPPAGE_OPTIONS = [50, 100, 200]; // bps

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SwapCard() {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();

  const [from, setFrom] = useState<Token>(REMOTE_TOKENS[0]); // ETH on Ethereum
  const [to, setTo] = useState<Token>(BSC_TOKENS.find((t) => t.symbol === "CAR")!);
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);

  const flow = useSwapFlow();

  // Invariant: exactly one side must be a BNB Chain token.
  function selectFrom(t: Token) {
    flow.reset();
    setFrom(t);
    if (!isBscToken(t) && !isBscToken(to)) setTo(USDT_BSC);
  }
  function selectTo(t: Token) {
    flow.reset();
    setTo(t);
    if (!isBscToken(t) && !isBscToken(from)) setFrom(USDT_BSC);
  }
  function flip() {
    flow.reset();
    setFrom(to);
    setTo(from);
  }

  const amountIn = useMemo(() => safeParseUnits(amount, from.decimals), [amount, from.decimals]);
  const debouncedAmountIn = useDebounced(amountIn, 400);

  const plan = useMemo(() => planSwap(from, to), [from, to]);
  const quote = useQuote(from, to, debouncedAmountIn, address ?? undefined);

  const output = quote.data?.output;
  const minReceived = output != null ? applySlippage(output, slippageBps) : undefined;

  const rzswapNeeded = plan.legs.some((l) => l.kind === "rzswap");
  const blockedByConfig = rzswapNeeded && !RZSWAP_CONFIGURED;

  const canStart =
    isConnected &&
    !!address &&
    plan.kind !== "invalid" &&
    amountIn > 0n &&
    !blockedByConfig &&
    !quote.isError;

  async function mainAction() {
    if (!isConnected || !address) {
      open();
      return;
    }
    if (flow.status === "idle") {
      flow.prepare({ from, to, amountIn, slippageBps, address: address as `0x${string}` });
      return;
    }
    if (flow.status === "awaiting") {
      await flow.confirmNext();
      return;
    }
    if (flow.status === "done" || flow.status === "error") {
      flow.reset();
      if (flow.status === "done") setAmount("");
    }
  }

  const buttonLabel = (() => {
    if (!isConnected) return "Connect Wallet";
    if (blockedByConfig) return "RzSwap not configured";
    if (plan.kind === "invalid") return plan.error ?? "Invalid pair";
    if (amountIn === 0n) return "Enter an amount";
    if (flow.status === "idle") return "Review route";
    if (flow.status === "running") return "Confirming…";
    if (flow.status === "awaiting")
      return `Confirm step ${flow.current + 1} of ${flow.legs.length}: ${flow.legs[flow.current]?.label}`;
    if (flow.status === "done") return "Swap complete ✓ — start new";
    if (flow.status === "error") return "Retry — review again";
    return "Swap";
  })();

  const buttonDisabled =
    flow.status === "running" || (flow.status === "idle" && !canStart) || (!isConnected ? false : !canStart && flow.status === "idle");

  return (
    <div className="w-full max-w-md rounded-xl2 border border-border bg-panel p-4 shadow-2xl">
      {/* FROM */}
      <div className="rounded-xl2 bg-bg/60 p-4">
        <div className="mb-2 flex items-center justify-between text-xs text-muted">
          <span>You pay</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => {
              flow.reset();
              setAmount(e.target.value.replace(/[^0-9.]/g, ""));
            }}
            className="w-full bg-transparent text-2xl font-semibold placeholder:text-muted"
          />
          <TokenSelector label="Pay with" selected={from} options={ALL_TOKENS} onSelect={selectFrom} />
        </div>
      </div>

      {/* FLIP */}
      <div className="my-2 flex justify-center">
        <button
          onClick={flip}
          className="rounded-full border border-border bg-panel p-2 text-muted transition-colors hover:text-white"
          aria-label="Flip direction"
        >
          ↓↑
        </button>
      </div>

      {/* TO */}
      <div className="rounded-xl2 bg-bg/60 p-4">
        <div className="mb-2 flex items-center justify-between text-xs text-muted">
          <span>You receive (estimated)</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="w-full text-2xl font-semibold text-muted">
            {quote.isFetching ? "…" : output != null ? formatAmount(output, to.decimals) : "0.0"}
          </div>
          <TokenSelector label="Receive" selected={to} options={ALL_TOKENS} onSelect={selectTo} />
        </div>
      </div>

      {/* ROUTE + DETAILS */}
      <div className="mt-3 space-y-1.5 px-1 text-xs text-muted">
        <div className="flex items-center justify-between">
          <span>Route</span>
          <span className="text-right text-[11px]">
            {plan.legs.map((l) => l.detail).join("  →  ") || "—"}
          </span>
        </div>
        {minReceived != null && (
          <div className="flex items-center justify-between">
            <span>Min received ({(slippageBps / 100).toFixed(2)}% slippage)</span>
            <span>
              {formatAmount(minReceived, to.decimals)} {to.symbol}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span>Slippage</span>
          <span className="flex gap-1">
            {SLIPPAGE_OPTIONS.map((bps) => (
              <button
                key={bps}
                onClick={() => setSlippageBps(bps)}
                className={`rounded-md px-2 py-0.5 ${slippageBps === bps ? "bg-accent text-white" : "bg-panelHover"}`}
              >
                {bps / 100}%
              </button>
            ))}
          </span>
        </div>
      </div>

      {quote.isError && (
        <div className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {(quote.error as Error)?.message ?? "Could not fetch a quote."}
        </div>
      )}

      {/* STEP TRACKER */}
      {flow.legs.length > 0 && <StepTracker legs={flow.legs} />}

      {/* ACTION */}
      <button
        onClick={mainAction}
        disabled={buttonDisabled}
        className="mt-4 w-full rounded-xl2 bg-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-accentHover disabled:cursor-not-allowed disabled:opacity-40"
      >
        {buttonLabel}
      </button>

      {flow.status === "awaiting" && flow.current > 0 && (
        <p className="mt-2 text-center text-xs text-muted">
          Step {flow.current} confirmed. Confirm the next step to continue.
        </p>
      )}
    </div>
  );
}
