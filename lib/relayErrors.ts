/**
 * The Relay SDK fires a best-effort "notify the solver" call (`POST /transactions/index`) after the
 * deposit tx is broadcast, WITHOUT awaiting or catching it (see utils/transaction.js
 * `postTransactionToSolver`). When Relay's backend transiently can't find the just-mined receipt it
 * responds with "Transaction receipt not found for txHash", which surfaces as an UNHANDLED promise
 * rejection. The bridge itself is unaffected — the solver also detects the deposit on-chain — so
 * this rejection is benign and should not crash the app.
 */
export function isBenignRelaySolverError(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const r = reason as { message?: unknown; type?: unknown; cause?: unknown; name?: unknown; rawError?: { endpoint?: unknown } };
  const message = String(r.message ?? "");
  const endpoint = String(r.rawError?.endpoint ?? "");
  const isApiError = r.type === "APIError" || r.cause === "APIError" || r.name === "APIError";

  if (endpoint.includes("/transactions/index")) return true;
  if (/transaction receipt not found/i.test(message)) return true;
  if (isApiError && /receipt not found|not found for txhash/i.test(message)) return true;
  return false;
}

/** True when Relay rejects a swap because the output can't cover the fixed bridge/network fee. */
export function isAmountTooSmallError(input: unknown): boolean {
  const m = input instanceof Error ? input.message : String(input ?? "");
  return /too small to cover fees|amount is too small|insufficient.*to cover/i.test(m);
}

/**
 * Maps a raw Relay/quote error into a short, user-facing message. The most common one for small
 * cross-chain sells is the fee floor (the bridge has a near-fixed network fee — ~$0.18 to Tron), so
 * we explain it and suggest a larger amount instead of surfacing Relay's cryptic text.
 */
export function friendlyRelayError(input: unknown): string {
  const raw = (input instanceof Error ? input.message : String(input ?? "")).replace(/^Relay sell quote failed:\s*/i, "");
  if (isAmountTooSmallError(raw)) {
    return "Amount too small to cover the Tron network fee. Delivering USDT on Tron costs ~$1 (and ~$1.6 to an address that has never held USDT — a one-time activation). Sell a larger amount — about $2 or more.";
  }
  if (/no quotes|no routes|unsupported/i.test(raw)) {
    return "No bridge route available for this pair right now. Try a different amount or token.";
  }
  return raw || "Could not fetch a quote.";
}

let installed = false;

/**
 * Installs a window-level guard that swallows the benign Relay solver-notification rejection so it
 * doesn't trigger the Next.js error overlay or an uncaught-rejection in production. All other
 * rejections propagate untouched.
 */
export function installRelayRejectionGuard() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("unhandledrejection", (event) => {
    if (isBenignRelaySolverError(event.reason)) {
      event.preventDefault();
      // eslint-disable-next-line no-console
      console.warn("[rzswap] suppressed benign Relay solver-notification error:", (event.reason as Error)?.message);
    }
  });
}
