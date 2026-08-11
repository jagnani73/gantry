"use client";

import { useEffect } from "react";

/**
 * The boundary of last resort: the root layout itself threw.
 *
 * It REPLACES that layout, so nothing the layout sets up is available here —
 * not the fonts (`next/font` variables are declared on the `<html>` element the
 * layout renders), not the providers, and not reliably the design tokens, since
 * `globals.css` is imported by the module that just failed. Everything below is
 * therefore inline and self-contained on purpose: a fallback that depends on the
 * thing it is a fallback for is not one.
 *
 * The colours are the two that matter from `globals.css` — paper and ink — typed
 * out rather than referenced. This is the THIRD of the three documented places
 * hex may appear outside that file (the others being the static icon assets and
 * `manifest.ts`), and for the same reason as both: there is no stylesheet in
 * scope to hold a token.
 *
 * No links, only a reload. Client-side navigation needs the router this file
 * exists because we may not have.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("gantry: unhandled error above the root layout", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          padding: "2rem 1.5rem",
          textAlign: "center",
          background: "#f4f2ed",
          color: "#14150f",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 600 }}>Gantry failed to load</h1>
        <p style={{ margin: 0, maxWidth: "44ch", lineHeight: 1.5, opacity: 0.7 }}>
          The app could not start in this browser. Nothing on-chain is affected: settled payments
          and saved policies are unchanged.
        </p>
        {error.digest ? (
          <p style={{ margin: 0, fontFamily: "ui-monospace, monospace", fontSize: "0.8rem", opacity: 0.5 }}>
            reference {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: "1rem",
            height: "3rem",
            padding: "0 1.5rem",
            borderRadius: "0.75rem",
            border: "none",
            cursor: "pointer",
            background: "#14150f",
            color: "#f4f2ed",
            fontSize: "0.9375rem",
            fontWeight: 500,
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
