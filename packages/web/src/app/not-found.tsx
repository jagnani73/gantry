import Link from "next/link";
import { GantryMark } from "@/components/primitives";

/**
 * The 404, which until now was Next's stock black-on-white page.
 *
 * It is reachable in exactly one way that matters: `/qr/[handle]` calls
 * `notFound()` for a handle nobody has registered, which is what someone gets
 * after mistyping a shop name while trying to print a standee. Everything else
 * that takes a handle — `/pay`, `/m`, `/merchant` — resolves it client-side and
 * says so in its own words, which is better than a 404 because those screens can
 * offer the shop's neighbours.
 *
 * So this page's job is to name the likely mistake rather than to be decorative,
 * and to put the directory one tap away: the handle is the thing that was
 * probably wrong, and the directory is where the right ones are.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-16 text-center">
      <GantryMark className="h-9 w-auto" />
      <h1 className="mt-7 text-title-lg">This page isn&apos;t here</h1>
      <p className="mt-3 max-w-[46ch] text-body text-muted">
        If you followed a link to a shop, the handle may be misspelled, or that shop may not have
        registered on Gantry. Handles are exact: <span className="font-mono">ah-hock-chicken-rice</span>,
        not <span className="font-mono">Ah Hock</span>.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
        <Link
          href="/merchants"
          className="focus-ring flex h-12 items-center rounded-control-m bg-ink px-6 text-btn-sm font-medium text-paper transition-colors hover:bg-ink-hover"
        >
          Browse registered shops
        </Link>
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
