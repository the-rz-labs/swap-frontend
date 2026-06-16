import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "RzSwap — cross-chain into the RZ ecosystem",
  description: "Swap any token into RZ ecosystem tokens on BNB Chain. Cross-chain via Relay, final swap via RzSwap.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
