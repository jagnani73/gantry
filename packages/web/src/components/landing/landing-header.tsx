import Link from "next/link";
import { GantryMark } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { GUTTER_X, MERCHANTS_HREF, REPO_URL } from "./content";

/* The base layer paints every `a` accent green; these are navigation, not links
   into the argument, so they take the text ladder instead. Utilities sit in a
   later cascade layer, so they win over the base rule without !important. */
const NAV_LINK = "focus-ring rounded-badge text-body text-quiet transition-colors hover:text-ink";

export function LandingHeader() {
  return (
    <header
      className={cn(
        "flex items-center justify-between border-b border-hairline-strong py-6.5",
        GUTTER_X,
      )}
    >
      {/* Scaled as a LOCKUP, not as a glyph: the mark is ~square and already
          runs to twice the wordmark's cap height, so growing it alone reads as
          a logo with a caption rather than a wordmark. The directory header
          (components/directory/directory-chrome.tsx) carries the same three
          values on purpose — change one, change both. */}
      <div className="flex items-center gap-3.5">
        <GantryMark className="h-9" />
        <span className="text-title-lg">Gantry</span>
      </div>
      <nav className="flex items-center gap-4 sm:gap-6.5">
        {/* Dropped below 640px: the wordmark plus five links does not fit a 375px
            phone, and every anchor only jumps to a section one scroll away.
            Each label is a literal prefix of the heading it lands on — a nav that
            promises a word the destination never says reads as a broken link
            even when the scroll works. */}
        <a className={cn(NAV_LINK, "hidden sm:inline")} href="#how-it-works">
          How it works
        </a>
        <a className={cn(NAV_LINK, "hidden sm:inline")} href="#who-can-pay">
          Who can pay
        </a>
        <a className={cn(NAV_LINK, "hidden sm:inline")} href="#contracts">
          Contracts
        </a>
        {/* The only INTERNAL entry here that leaves the page rather than
            scrolling it (GitHub below leaves too, but off-site). Kept at every
            width for that reason: the anchors above are a convenience for a
            scroll a reader could do themselves, this is another page. */}
        <Link className={NAV_LINK} href={MERCHANTS_HREF}>
          Merchants
        </Link>
        <a className={NAV_LINK} href={REPO_URL} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </nav>
    </header>
  );
}
