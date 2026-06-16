"use client";

import { CHAIN_NAMES } from "@/lib/tokens";
import { shortHash } from "@/lib/format";
import type { RunLeg } from "@/hooks/useSwapFlow";

const DOT: Record<RunLeg["status"], string> = {
  pending: "bg-border",
  active: "bg-accent animate-pulse",
  done: "bg-emerald-500",
  error: "bg-red-500",
};

function explorerTx(chainId: number | undefined, hash: string): string {
  const base: Record<number, string> = {
    56: "https://bscscan.com/tx/",
    1: "https://etherscan.io/tx/",
    42161: "https://arbiscan.io/tx/",
    8453: "https://basescan.org/tx/",
    10: "https://optimistic.etherscan.io/tx/",
    137: "https://polygonscan.com/tx/",
  };
  return `${base[chainId ?? 56] ?? "https://bscscan.com/tx/"}${hash}`;
}

export function StepTracker({ legs }: { legs: RunLeg[] }) {
  if (legs.length === 0) return null;
  return (
    <div className="mt-4 space-y-3 rounded-xl2 border border-border bg-panel/60 p-4">
      {legs.map((leg, i) => (
        <div key={leg.key + i} className="flex items-start gap-3">
          <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${DOT[leg.status]}`} />
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{leg.label}</span>
              <span className="text-xs text-muted">{CHAIN_NAMES[leg.chainId ?? 56]}</span>
            </div>
            {leg.txHash && (
              <a
                href={explorerTx(leg.chainId, leg.txHash)}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent hover:underline"
              >
                {shortHash(leg.txHash)} ↗
              </a>
            )}
            {leg.error && <div className="text-xs text-red-400">{leg.error}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
