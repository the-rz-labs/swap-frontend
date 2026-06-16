"use client";

import { useState } from "react";
import { CHAINS, type Token } from "@/lib/tokens";

/** Deterministic pastel hue from a string, for fallback avatars. */
function hueOf(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Logo({ src, alt, size = 28, className = "" }: { src?: string; alt: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const showFallback = !src || failed;

  if (showFallback) {
    const initials = alt.replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase();
    return (
      <div
        className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${className}`}
        style={{ width: size, height: size, background: `hsl(${hueOf(alt)} 45% 38%)`, fontSize: size * 0.36 }}
        aria-label={alt}
      >
        {initials}
      </div>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-full bg-panelHover object-cover ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** A token logo with a small chain logo badge in the bottom-right corner (Relay style). */
export function TokenWithChain({ token, size = 36 }: { token: Token; size?: number }) {
  const chain = CHAINS[token.chainId];
  const badge = Math.round(size * 0.42);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <Logo src={token.logoURI} alt={token.symbol} size={size} />
      {chain && (
        <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-panel">
          <Logo src={chain.logoURI} alt={chain.shortName} size={badge} />
        </span>
      )}
    </div>
  );
}
