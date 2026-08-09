import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";
import { Providers } from "./providers";

/* Self-hosted at build time by next/font — a <link> to fonts.googleapis.com would
   put a third-party round trip in front of first paint on a venue hotspot, and the
   demo laptop may be on a captive portal when it happens. Instrument Sans is a
   variable font, so the 400/500/600 the design uses come from one file. */
const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-instrument-sans",
});

/* Every number, address, hash and uppercase micro-label. Static weights, so both
   the ones the design uses have to be asked for by name. */
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-ibm-plex-mono",
});

export const metadata: Metadata = {
  title: "Gantry",
  description: "Payer-agnostic payment rail on stablecoins: QR for humans, x402 for AI agents.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrumentSans.variable} ${ibmPlexMono.variable}`}>
      <body className="min-h-dvh bg-paper font-sans text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
