import { ConnectButton } from "@/components/ConnectButton";
import { SwapCard } from "@/components/SwapCard";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-accent" />
          <span className="text-lg font-bold tracking-tight">RzSwap</span>
        </div>
        <ConnectButton />
      </header>

      <section className="flex flex-1 flex-col items-center justify-center px-4 pb-16">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold">Swap into the RZ ecosystem</h1>
          <p className="mt-1 text-sm text-muted">
            Any chain in, any RZ token out — one side is always on BNB Chain.
          </p>
        </div>
        <SwapCard />
        <p className="mt-6 max-w-md text-center text-xs text-muted">
          Cross-chain legs are bridged via Relay to USDT on BNB Chain; the final swap runs through the
          RzSwap contract. Each step is confirmed by you.
        </p>
      </section>
    </main>
  );
}
