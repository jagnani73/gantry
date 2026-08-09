import type { MetadataRoute } from "next";

/**
 * Exists for the icon story, not for an install prompt: without a manifest,
 * Android home-screen shortcuts fall back to a screenshot of the page instead of
 * the mark, and the maskable variant is the only way to stop a launcher cropping
 * the portal's legs off.
 *
 * `start_url` is the landing page rather than `/app`, because a deployed Gantry
 * is a shop window that has to explain itself before it hands anyone a wallet.
 *
 * The two colours are the ONE place `--color-paper` is repeated outside
 * globals.css. A manifest is JSON read by the OS shell before any stylesheet
 * exists, so there is no token to reference — see the same note on the generated
 * icons, which carry the ink and green for the same reason.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Gantry",
    short_name: "Gantry",
    description:
      "Payer-agnostic payment rail on stablecoins: QR for humans, x402 for AI agents.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f2ed",
    theme_color: "#f4f2ed",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
