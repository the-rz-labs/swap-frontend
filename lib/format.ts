import { formatUnits, parseUnits } from "viem";

/** Parses a human amount string into base units; returns 0n on empty/invalid input. */
export function safeParseUnits(value: string, decimals: number): bigint {
  if (!value || value.trim() === "") return 0n;
  try {
    return parseUnits(value as `${number}`, decimals);
  } catch {
    return 0n;
  }
}

/** Formats base units to a trimmed, fixed-precision display string. */
export function formatAmount(value: bigint, decimals: number, maxFractionDigits = 6): string {
  const full = formatUnits(value, decimals);
  const [int, frac = ""] = full.split(".");
  if (frac === "") return int;
  const trimmed = frac.slice(0, maxFractionDigits).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/**
 * Generates a random 32-byte id for a swap (the contract's `swapId`, echoed in the `Swapped` event).
 * In production this should ideally be issued by the backend so it knows the id ahead of the event;
 * the frontend then passes it to swap() and reports it. A client-side random id works as a fallback.
 */
export function randomSwapId(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

/** Formats a USD number like "$1,234.56"; returns undefined for missing/invalid input. */
export function formatUsd(n?: number): string | undefined {
  if (n == null || !isFinite(n)) return undefined;
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return "<$0.01";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
