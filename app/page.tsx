import { ConnectButton } from "@/components/ConnectButton";
import { SwapCard } from "@/components/SwapCard";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border/60 bg-bg/70 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-accent to-fuchsia-500" />
          <span className="text-lg font-bold tracking-tight">RzSwap</span>
        </div>
        <ConnectButton />
      </header>

      <section className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="mb-7 text-center">
          <h1 className="text-balance text-3xl font-bold tracking-tight">Swap into the RZ ecosystem</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            Bridge from Ethereum and swap into RZ tokens on BNB Chain — one side is always BSC.
          </p>
        </div>

        <SwapCard />

        <p className="mt-6 max-w-md text-center text-xs text-muted">
          Cross-chain legs are bridged via Relay to USDT on BNB Chain; the final swap runs through the
          RzSwap contract.
        </p>
      </section>
    </main>
  );
}
