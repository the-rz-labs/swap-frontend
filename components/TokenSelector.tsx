"use client";

import { useState } from "react";
import { CHAIN_NAMES, tokenKey, type Token } from "@/lib/tokens";

type Props = {
  label: string;
  selected: Token;
  options: Token[];
  onSelect: (t: Token) => void;
};

export function TokenSelector({ label, selected, options, onSelect }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl2 bg-panelHover px-3 py-2 text-sm font-semibold transition-colors hover:bg-border"
      >
        <span>{selected.symbol}</span>
        <span className="text-xs font-normal text-muted">{CHAIN_NAMES[selected.chainId] ?? selected.chainId}</span>
        <span className="text-muted">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 max-h-80 w-72 overflow-y-auto rounded-xl2 border border-border bg-panel p-1 shadow-xl">
            <div className="px-3 py-2 text-xs uppercase tracking-wide text-muted">{label}</div>
            {options.map((t) => {
              const active = tokenKey(t) === tokenKey(selected);
              return (
                <button
                  key={tokenKey(t)}
                  onClick={() => {
                    onSelect(t);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-panelHover ${
                    active ? "bg-panelHover" : ""
                  }`}
                >
                  <div>
                    <div className="font-semibold">{t.symbol}</div>
                    <div className="text-xs text-muted">{t.name}</div>
                  </div>
                  <div className="text-xs text-muted">{CHAIN_NAMES[t.chainId] ?? t.chainId}</div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
