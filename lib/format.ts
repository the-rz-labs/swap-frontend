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
