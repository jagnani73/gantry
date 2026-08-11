"use client";

import { useEffect } from "react";
import Link from "next/link";
import { GantryMark } from "@/components/primitives";

/**
 * What a client-side exception looks like instead of Next's default.
 *
 * The default is a blank page reading "Application error: a client-side
 * exception has occurred", with the message stripped in production. This screen
 * is on a projector for three minutes at the finals, so a blank page is the
 * worst possible failure mode: there is no way to tell a crash from a hung
 * network, and nothing on screen to act on.
 *
 * Two things this deliberately does NOT claim. It does not say a payment failed
 * — a render error says nothing about what settled, and every payment in Gantry
 * is a chain fact this component cannot see. And `reset()` is offered as
 * re-rendering the screen, not as retrying anything: it remounts the segment, so
 * a write that was in flight is not re-sent and must not be described as
 * resumed.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The console is the only place the real stack survives a production build,
    // and during a rehearsal it is the difference between a bug report and a
    // shrug. `digest` is the server-side correlate Next puts in its own logs.
    console.error("gantry: unhandled error in a client component", error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-16 text-center">
      <GantryMark className="h-9 w-auto" />
      <h1 className="mt-7 text-title-lg">This screen stopped working</h1>
      <p className="mt-3 max-w-[52ch] text-body text-muted">
        Something in the page failed to render. Nothing here changes what is on-chain: payments
        that settled are settled, and any policy you saved is still in force. Reloading is safe.
      </p>
      {error.digest ? (
        <p className="mt-3 font-mono text-mono-sm text-faint">reference {error.digest}</p>
      ) : null}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
        <button
          type="button"
          onClick={reset}
          className="focus-ring flex h-12 items-center rounded-control-m bg-ink px-6 text-btn-sm font-medium text-paper transition-colors hover:bg-ink-hover"
        >
          Try this screen again
        </button>
        <Link
          href="/"
          className="focus-ring flex h-12 items-center rounded-control-m bg-fill-subtle px-6 text-btn-sm font-medium text-ink transition-colors hover:bg-fill-hover-strong"
        >
          Back to Gantry
        </Link>
      </div>
    </main>
  );
}
