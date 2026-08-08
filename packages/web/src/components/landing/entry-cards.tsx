import Link from "next/link";
import { Label } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { GUTTER_X, MERCHANT_HREF, PAYER_HREF } from "./content";

/* The whole card is the target, so the focus ring belongs on the card and not on
   the "Open →" text inside it. */
const CARD = "focus-ring flex flex-col gap-3.5 rounded-panel px-9.5 py-9 transition-colors";

export function EntryCards() {
  return (
    <section className={cn("grid grid-cols-1 gap-5 pb-24 md:grid-cols-2", GUTTER_X)}>
      <Link
        href={MERCHANT_HREF}
        className={cn(CARD, "bg-surface text-ink hover:bg-fill-hover-card")}
      >
        <Label size="eyebrow">For shops</Label>
        <div className="text-display">Merchant app</div>
        <p className="max-w-[44ch] text-body-lg text-quiet">
          Live settlements, transaction history, payouts, your printed QR, and the public shop
          identity payers see.
        </p>
        <span className="mt-1.5 text-list-title text-accent">Open →</span>
      </Link>

      <Link href={PAYER_HREF} className={cn(CARD, "bg-ink text-paper hover:bg-ink-hover")}>
        {/* Accent green is unreadable on ink, so the eyebrow and the call to
            action both step onto the paper/soft-green pair instead. */}
        <Label size="eyebrow" tone="inherit" className="text-paper/50">
          For payers
        </Label>
        <div className="text-display">Payer app</div>
        <p className="max-w-[44ch] text-body-lg text-paper/68">
          Scan, pay, and keep the receipt. Your history, the places you&apos;ve paid, and the agents
          spending on your behalf.
        </p>
        <span className="mt-1.5 text-list-title text-accent-soft">Open →</span>
      </Link>
    </section>
  );
}
