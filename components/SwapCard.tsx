"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseEther, isAddress } from "viem";
import { useAccount } from "wagmi";
import { useDynamicContext, useUserWallets } from "@dynamic-labs/sdk-react-core";
import { ALL_TOKENS, CHAIN_NAMES, USDT_BSC, isBscToken, isNative, isTronToken, tokenKey, type Token } from "@/lib/tokens";
import { isTronAddress } from "@/lib/tron/tronAddress";
import { setTronSigner, tronSignerFromWallet } from "@/lib/tron/tronDynamic";
import { friendlyRelayError, isAmountTooSmallError } from "@/lib/relayErrors";
import { RZSWAP_CONFIGURED } from "@/lib/rzswap";
import { planSwap, applySlippage } from "@/lib/swapPlan";
import { safeParseUnits, formatAmount, formatUsd, randomSwapId } from "@/lib/format";
import { useQuote } from "@/hooks/useQuote";
import { useSwapFlow } from "@/hooks/useSwapFlow";
import { useBalances } from "@/hooks/useBalances";
import { TokenSelectModal } from "./TokenSelectModal";
import { StepTracker } from "./StepTracker";
import { TokenWithChain } from "./Logo";

const SLIPPAGE_OPTIONS = [50, 100, 200]; // bps

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function TokenButton({ token, onClick }: { token: Token; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex shrink-0 items-center gap-2 rounded-full bg-panelHover py-1.5 pl-1.5 pr-3 transition-colors hover:bg-border"
    >
      <TokenWithChain token={token} size={28} />
      <span className="font-semibold">{token.symbol}</span>
      <span className="text-muted">▾</span>
    </button>
  );
}

export function SwapCard() {
  // EVM account comes through wagmi (Dynamic bridges the connected wallet via DynamicWagmiConnector).
  const { address, isConnected } = useAccount();
  // Dynamic drives the multichain "Log in or sign up" modal; the Tron wallet (if connected) shows up
  // in userWallets and is recognised by its base58 address — robust to Dynamic's chain naming.
  const { setShowAuthFlow } = useDynamicContext();
  const userWallets = useUserWallets();
  const tronWallet = useMemo(
    () => userWallets.find((w) => w.address && isTronAddress(w.address)),
    [userWallets],
  );
  const tronAddr = tronWallet?.address;

  // Publish the connected Tron wallet's signer to the (non-React) Relay execution path.
  useEffect(() => {
    let active = true;
    if (!tronWallet) {
      setTronSigner(undefined);
      return;
    }
    tronSignerFromWallet(tronWallet).then((s) => {
      if (active) setTronSigner(s);
    });
    return () => {
      active = false;
    };
  }, [tronWallet]);

  const [from, setFrom] = useState<Token>(ALL_TOKENS.find((t) => t.symbol === "ETH")!);
  const [to, setTo] = useState<Token>(ALL_TOKENS.find((t) => t.symbol === "CAR" && isBscToken(t))!);
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [picker, setPicker] = useState<"from" | "to" | null>(null);
  // Destination address on a non-EVM target (Tron). EVM targets use the connected wallet.
  const [destAddress, setDestAddress] = useState("");

  const tronDest = isTronToken(to);
  const tronSource = isTronToken(from); // paying FROM Tron — needs a connected Tron wallet

  const flow = useSwapFlow();

  const { data: balances } = useBalances(ALL_TOKENS, address ?? undefined, tronAddr);

  // Invariant: exactly one side must be a BNB Chain token.
  function selectFrom(t: Token) {
    flow.reset();
    setFrom(t);
    if (!isBscToken(t) && !isBscToken(to)) setTo(USDT_BSC);
    if (tokenKey(t) === tokenKey(to)) setTo(from);
    setPicker(null);
  }
  function selectTo(t: Token) {
    flow.reset();
    setTo(t);
    if (!isBscToken(t) && !isBscToken(from)) setFrom(USDT_BSC);
    if (tokenKey(t) === tokenKey(from)) setFrom(to);
    setPicker(null);
  }
  function flip() {
    flow.reset();
    setFrom(to);
    setTo(from);
  }

  const amountIn = useMemo(() => safeParseUnits(amount, from.decimals), [amount, from.decimals]);
  const debouncedAmountIn = useDebounced(amountIn, 400);

  const plan = useMemo(() => planSwap(from, to), [from, to]);
  const isCrossChain = plan.kind === "inbound" || plan.kind === "outbound";

  // Destination recipient: the wallet auto-available on the destination chain (the Tron wallet for a
  // Tron destination, the EVM wallet otherwise), or a manually pasted address validated for that chain.
  const connectedDest = tronDest ? tronAddr : isConnected ? address : undefined;
  const destEntered = destAddress.trim();
  const destEnteredValid = tronDest ? isTronAddress(destEntered) : isAddress(destEntered);
  const destRecipient = connectedDest ?? (destEnteredValid ? destEntered : undefined);
  const showDestField = isCrossChain && !connectedDest; // need a manual address (no dest-chain wallet)
  const destOk = !isCrossChain || !!destRecipient;
  // Source wallet readiness: a Tron source needs the Tron wallet; everything else needs an EVM wallet.
  const sourceReady = tronSource ? !!tronAddr : isConnected && !!address;

  // Debounced recipient for the quote. The cross-chain output is recipient-independent for EVM dests,
  // but the Tron delivery fee depends on the recipient, so feed it the real address when available.
  const debouncedDestAddr = useDebounced(destEntered, 400);
  const debouncedDestValid = tronDest ? isTronAddress(debouncedDestAddr) : isAddress(debouncedDestAddr);
  const quoteRecipient = connectedDest ?? (debouncedDestValid ? debouncedDestAddr : undefined);
  const quote = useQuote(from, to, debouncedAmountIn, quoteRecipient);

  const routeDetail = plan.legs.map((l) => l.detail).join("  →  ") || "—";

  const output = quote.data?.output;
  const minReceived = output != null ? applySlippage(output, slippageBps) : undefined;
  const priceDiff =
    quote.data?.inputUsd && quote.data?.outputUsd && quote.data.inputUsd > 0
      ? ((quote.data.outputUsd - quote.data.inputUsd) / quote.data.inputUsd) * 100
      : undefined;

  const fromBal = balances?.[tokenKey(from)];
  const toBal = balances?.[tokenKey(to)];

  function setMax() {
    if (fromBal == null || fromBal === 0n) return;
    let max = fromBal;
    if (isNative(from)) max = max > parseEther("0.0005") ? max - parseEther("0.0005") : 0n; // gas buffer
    setAmount(formatUnits(max, from.decimals));
    flow.reset();
  }

  const rzswapNeeded = plan.legs.some((l) => l.kind === "rzswap") || (plan.kind === "inbound" && !plan.hubIsEndpoint);
  const blockedByConfig = rzswapNeeded && !RZSWAP_CONFIGURED;
  const insufficient = fromBal != null && amountIn > fromBal;

  const canStart =
    sourceReady && destOk && plan.kind !== "invalid" && amountIn > 0n && !blockedByConfig && !insufficient && !quote.isError;

  function mainAction() {
    if (!sourceReady) return setShowAuthFlow(true);
    if (flow.status === "idle")
      // swapId ideally comes from the backend; a client-side random id is used as a fallback.
      return flow.start({
        from,
        to,
        amountIn,
        slippageBps,
        // For a buy (inbound) the recipient is the destination BNB-Chain address; otherwise it's the
        // connected EVM signer. For a sell to Tron, the Tron destination goes in `destAddress`.
        address: (plan.kind === "inbound" ? destRecipient : address) as `0x${string}`,
        destAddress: tronDest && plan.kind === "outbound" ? destRecipient : undefined,
        tronAddress: tronSource ? tronAddr : undefined,
        swapId: randomSwapId(),
      });
    if (flow.status === "error") return flow.retry();
    if (flow.status === "done") {
      flow.reset();
      setAmount("");
    }
  }

  const buttonLabel = (() => {
    if (!sourceReady) return tronSource ? "Connect Tron wallet" : "Connect Wallet";
    if (blockedByConfig) return "RzSwap not configured";
    if (plan.kind === "invalid") return plan.error ?? "Invalid pair";
    if (amountIn === 0n) return "Enter an amount";
    if (insufficient) return `Insufficient ${from.symbol}`;
    if (!destOk) return tronDest ? "Enter a Tron address" : "Enter destination address";
    if (quote.isError && isAmountTooSmallError(quote.error)) return "Amount too small";
    if (flow.status === "running") return "Swapping…";
    if (flow.status === "done") return "Swap complete ✓ — start new";
    if (flow.status === "error") return "Retry";
    return "Swap";
  })();

  const buttonDisabled = flow.status === "running" || (flow.status === "idle" && !canStart);

  return (
    <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-3 shadow-2xl sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold text-muted">Swap</h2>
      </div>

      {/* FROM */}
      <div className="rounded-2xl bg-bg/50 p-4">
        <div className="mb-2 flex items-center justify-between text-xs text-muted">
          <span>You pay</span>
          {fromBal != null && (
            <span className="flex items-center gap-2">
              <span>Balance: {formatAmount(fromBal, from.decimals, 4)}</span>
              {fromBal > 0n && (
                <button onClick={setMax} className="font-semibold text-accent hover:text-accentHover">
                  MAX
                </button>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <input
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => {
              flow.reset();
              setAmount(e.target.value.replace(/[^0-9.]/g, ""));
            }}
            className="w-full min-w-0 bg-transparent text-3xl font-semibold placeholder:text-muted"
          />
          <TokenButton token={from} onClick={() => setPicker("from")} />
        </div>
        <div className="mt-1 h-4 text-sm text-muted">{formatUsd(quote.data?.inputUsd) ?? ""}</div>
      </div>

      {/* FLIP */}
      <div className="relative z-10 -my-3 flex justify-center">
        <button
          onClick={flip}
          className="rounded-xl border-4 border-panel bg-panelHover p-2 text-muted transition-colors hover:text-white"
          aria-label="Switch direction"
        >
          ↓
        </button>
      </div>

      {/* TO */}
      <div className="rounded-2xl bg-bg/50 p-4">
        <div className="mb-2 flex items-center justify-between text-xs text-muted">
          <span>You receive</span>
          {toBal != null && <span>Balance: {formatAmount(toBal, to.decimals, 4)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="w-full min-w-0 truncate text-3xl font-semibold text-white/90">
            {quote.isFetching && output == null ? "…" : output != null ? formatAmount(output, to.decimals) : "0"}
          </div>
          <TokenButton token={to} onClick={() => setPicker("to")} />
        </div>
        <div className="mt-1 flex h-4 items-center gap-2 text-sm text-muted">
          <span>{formatUsd(quote.data?.outputUsd) ?? ""}</span>
          {priceDiff != null && Math.abs(priceDiff) >= 0.01 && (
            <span className={priceDiff < 0 ? "text-red-400" : "text-emerald-400"}>
              ({priceDiff > 0 ? "+" : ""}
              {priceDiff.toFixed(2)}%)
            </span>
          )}
        </div>
      </div>

      {/* DESTINATION ADDRESS — shown for a cross-chain route when no wallet is connected on the
          destination chain (e.g. buying a BNB-Chain token while paying from Tron, or selling to Tron). */}
      {showDestField && (
        <div className="mt-3 rounded-2xl bg-bg/50 p-4">
          <div className="mb-2 text-xs text-muted">
            {tronDest ? "Tron destination address" : `${CHAIN_NAMES[to.chainId] ?? "Destination"} address`}
          </div>
          <input
            spellCheck={false}
            placeholder={tronDest ? "T…" : "0x…"}
            value={destAddress}
            onChange={(e) => {
              flow.reset();
              setDestAddress(e.target.value.trim());
            }}
            className="w-full min-w-0 bg-transparent font-mono text-sm placeholder:text-muted"
          />
          {destEntered.length > 0 && !destEnteredValid && (
            <div className="mt-1 text-xs text-red-400">Not a valid {tronDest ? "Tron" : "address"}.</div>
          )}
          <div className="mt-1 text-[11px] text-muted">
            {to.symbol} is delivered to this {tronDest ? "Tron" : CHAIN_NAMES[to.chainId] ?? "destination"} address
            {tronDest ? " (e.g. your exchange deposit address)." : "."}
          </div>
        </div>
      )}

      {/* DETAILS */}
      {amountIn > 0n && (
        <div className="mt-3 space-y-2 rounded-xl border border-border/60 px-3 py-2.5 text-xs text-muted">
          <div className="flex items-center justify-between">
            <span>Route</span>
            <span className="text-right text-[11px] text-white/70">{routeDetail}</span>
          </div>
          {minReceived != null && (
            <div className="flex items-center justify-between">
              <span>Min. received</span>
              <span className="text-white/70">
                {formatAmount(minReceived, to.decimals)} {to.symbol}
              </span>
            </div>
          )}
          {quote.data?.bridgeFeeUsd != null && quote.data.bridgeFeeUsd > 0 && (
            <div className="flex items-center justify-between">
              <span>Bridge fee</span>
              <span className="text-white/70">≈ {formatUsd(quote.data.bridgeFeeUsd)}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span>Max slippage</span>
            <span className="flex gap-1">
              {SLIPPAGE_OPTIONS.map((bps) => (
                <button
                  key={bps}
                  onClick={() => setSlippageBps(bps)}
                  className={`rounded-md px-2 py-0.5 ${slippageBps === bps ? "bg-accent text-white" : "bg-panelHover text-muted"}`}
                >
                  {bps / 100}%
                </button>
              ))}
            </span>
          </div>
        </div>
      )}

      {quote.isError && (
        <div className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {friendlyRelayError(quote.error)}
        </div>
      )}

      {flow.legs.length > 0 && <StepTracker legs={flow.legs} />}

      <button
        onClick={mainAction}
        disabled={buttonDisabled}
        className="mt-3 w-full rounded-2xl bg-accent px-4 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-accentHover disabled:cursor-not-allowed disabled:opacity-40"
      >
        {buttonLabel}
      </button>

      {flow.status === "running" && flow.legs.length > 1 && (
        <p className="mt-2 text-center text-xs text-muted">Approve each wallet prompt as it appears — steps run automatically.</p>
      )}
      {flow.status === "idle" && amountIn > 0n && plan.kind === "inbound" && !plan.hubIsEndpoint && (
        <p className="mt-2 text-center text-xs text-muted">
          One signature: Relay bridges to USDT and swaps it into {to.symbol} on BNB Chain (USDT back if it can&apos;t fill).
        </p>
      )}

      <TokenSelectModal
        open={picker !== null}
        title={picker === "from" ? "Swap from" : "Swap to"}
        tokens={ALL_TOKENS}
        selectedKey={picker === "from" ? tokenKey(from) : tokenKey(to)}
        address={address ?? undefined}
        tronAddress={tronAddr}
        onSelect={picker === "from" ? selectFrom : selectTo}
        onClose={() => setPicker(null)}
      />
    </div>
  );
}
