import Link from "next/link";
import { BASE_SEPOLIA_CHAIN_ID } from "@gantry/shared";
import { GantryMark, Mono } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { GUTTER_X } from "@/components/landing/content";

/**
 * The directory's own header and footer.
 *
 * The header carries no section nav, deliberately: this page says what a
 * merchant is on this rail, and it does not lead into a back-office or a payer
 * flow. Merchant detail opens in place rather than on a screen of its own.
 *
 * The wordmark is the one exception, and it is the way back to the landing page
 * the directory is reached from. A logo that goes home is not navigation a
 * reader has to learn; a page with no way out is a dead end.
 *
 * That is why this does not reuse `LandingHeader`, whose whole body is a nav.
 */
export function DirectoryHeader() {
  return (
    <header
      className={cn(
        "flex items-center justify-between border-b border-hairline-strong py-6.5",
        GUTTER_X,
      )}
    >
      {/* The prototype drew the mark as a plain ink square; the real one lives in
          exactly one place and repaints with the design system. */}
      {/* Sized to match the landing header's lockup exactly — this page is one
          click from it, and a wordmark that shrinks on arrival reads as a
          different site. Change one, change both. */}
      <Link href="/" className="focus-ring flex items-center gap-3.5 rounded-badge">
        <GantryMark className="h-9" />
        <span className="text-title-lg text-ink">Gantry</span>
      </Link>
      <Mono size="3xs" tone="faint" className="tracking-[0.14em] uppercase">
        Merchant directory
      </Mono>
    </header>
  );
}

/**
 * The honest framing, and it is not decoration: a directory reads as an
 * endorsement unless it says otherwise. Nothing in Gantry reviews a merchant,
 * `registerMerchant` is permissionless, and the category a shop claims is the
 * one an agent's spend policy will act on — so the page that lists them all is
 * exactly where that has to be said.
 */
export function DirectoryFooter() {
  return (
    <footer
      className={cn(
        "flex flex-col gap-3 border-t border-hairline-strong pt-7.5 pb-13 text-meta text-faint sm:flex-row sm:items-start sm:justify-between sm:gap-12",
        GUTTER_X,
      )}
    >
      <p className="max-w-[74ch]">
        Categories are self-attested at registration. This deployment runs no KYC, so a listing is
        proof of an on-chain record and nothing more. Agents read the category to decide whether
        their spend policy permits a shop.
      </p>
      <Mono size="md" className="shrink-0">
        Base Sepolia · eip155:{BASE_SEPOLIA_CHAIN_ID}
      </Mono>
    </footer>
  );
}
