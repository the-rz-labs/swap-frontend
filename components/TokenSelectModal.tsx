"use client";

import { useMemo, useState } from "react";
import { CHAINS, tokenKey, type Token } from "@/lib/tokens";
import { formatAmount } from "@/lib/format";
import { useBalances } from "@/hooks/useBalances";
import { Logo, TokenWithChain } from "./Logo";

type Props = {
  open: boolean;
  title: string;
  tokens: Token[];
  selectedKey: string;
  address?: string;
  onSelect: (t: Token) => void;
  onClose: () => void;
};

export function TokenSelectModal({ open, title, tokens, selectedKey, address, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [chainFilter, setChainFilter] = useState<number | "all">("all");

  const chains = useMemo(() => {
    const ids = Array.from(new Set(tokens.map((t) => t.chainId)));
    return ids.map((id) => CHAINS[id]).filter(Boolean);
  }, [tokens]);

  const { data: balances } = useBalances(tokens, address);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tokens
      .filter((t) => (chainFilter === "all" ? true : t.chainId === chainFilter))
      .filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address.toLowerCase() === q)
      .sort((a, b) => {
        const ba = balances?.[tokenKey(a)] ?? 0n;
        const bb = balances?.[tokenKey(b)] ?? 0n;
        if (ba !== bb) return bb > ba ? 1 : -1; // tokens with balance first
        return 0;
      });
  }, [tokens, query, chainFilter, balances]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-border bg-panel shadow-2xl sm:rounded-2xl">
        {/* header */}
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted transition-colors hover:bg-panelHover hover:text-white">✕</button>
        </div>

        {/* search */}
        <div className="px-4 pt-3">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or paste address"
            className="w-full rounded-xl border border-border bg-bg/60 px-3 py-2.5 text-sm placeholder:text-muted focus:border-accent"
          />
        </div>

        {/* chain filter */}
        <div className="flex gap-2 px-4 pt-3">
          <button
            onClick={() => setChainFilter("all")}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${chainFilter === "all" ? "bg-accent text-white" : "bg-panelHover text-muted hover:text-white"}`}
          >
            All chains
          </button>
          {chains.map((c) => (
            <button
              key={c.id}
              onClick={() => setChainFilter(c.id)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${chainFilter === c.id ? "bg-accent text-white" : "bg-panelHover text-muted hover:text-white"}`}
            >
              <Logo src={c.logoURI} alt={c.shortName} size={16} />
              {c.shortName}
            </button>
          ))}
        </div>

        {/* list */}
        <div className="mt-3 flex-1 overflow-y-auto px-2 pb-3">
          {filtered.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted">No tokens found.</div>}
          {filtered.map((t) => {
            const active = tokenKey(t) === selectedKey;
            const bal = balances?.[tokenKey(t)];
            return (
              <button
                key={tokenKey(t)}
                onClick={() => onSelect(t)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-panelHover ${active ? "bg-panelHover" : ""}`}
              >
                <TokenWithChain token={t} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{t.symbol}</div>
                  <div className="truncate text-xs text-muted">{t.name}</div>
                </div>
                {bal != null && bal > 0n && (
                  <div className="text-right text-sm font-medium">{formatAmount(bal, t.decimals, 4)}</div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
