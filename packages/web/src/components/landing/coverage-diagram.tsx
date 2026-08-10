import { cn } from "@/lib/utils";
import { CARD_FEE_LABEL, GANTRY_FEE_LABEL } from "./content";

/**
 * Who each rail can actually take money from, drawn as nested regions.
 *
 * This is an EULER diagram, not a Venn, and the distinction is the whole reason
 * it works: the coverage relationship is `PayNow ⊂ Cards ⊂ Gantry`. There is no
 * payer PayNow reaches that Gantry does not, so a Venn's exclusive crescents
 * would be empty — it would draw distinctions the data does not contain. Nested
 * rings say the true thing instead: each rail stops somewhere, and only one of
 * them encloses everything.
 *
 * The bands are EQUAL WIDTH on purpose. Sizing them by population would make the
 * diagram assert a market ratio, and we do not have one to assert: resident
 * headcount is a stock, visitor arrivals are an annual flow, and the agent band
 * has no denominator at all. The caption says so rather than leaving the reader
 * to assume area means volume.
 *
 * Sits on a SUNKEN card. The ramp runs light-to-dark outward, so the innermost
 * region is the page's lightest surface — on a white card it disappears and the
 * diagram reads as a donut with a hole punched in it rather than three regions.
 */

/**
 * `inset` is each circle's edge as a % of the diameter, so the three rings come
 * out equal width. `labelTop` is the vertical centre of the band that circle
 * opens up, and `labelInsetX` is the chord available at that height — a label
 * wider than its own band spills onto the ring outside it, which is the one
 * thing that makes a diagram like this unreadable.
 */
const BANDS = [
  {
    inset: "inset-0",
    labelTop: "7.5%",
    labelInsetX: "inset-x-[24%]",
    fill: "bg-accent",
    text: "text-on-accent",
    subText: "text-on-accent-body",
    name: "AI agents",
    sub: null,
  },
  {
    inset: "inset-[15%]",
    labelTop: "22.5%",
    labelInsetX: "inset-x-[28%]",
    fill: "bg-accent-tint",
    text: "text-ink",
    subText: "text-quiet",
    name: "Tourists",
    sub: null,
  },
  {
    inset: "inset-[30%]",
    labelTop: "50%",
    labelInsetX: "inset-x-[30%]",
    fill: "bg-surface",
    text: "text-ink",
    subText: "text-quiet",
    name: "Residents",
    sub: "with a bank account",
  },
] as const;

/**
 * `reach` counts bands from the inside out, and doubles as the count of filled
 * pips in the row — so the list carries the diagram's information on its own.
 * That matters twice: a screen reader never sees the circles, and the ring a
 * rail stops at is the one fact this whole panel exists to deliver.
 *
 * `extra` is the second paragraph the Gantry row alone carries. It is the
 * surviving half of the old `WHY` block (see the note in content.ts): the
 * diagram can show that only one rail reaches the agent ring, but it cannot
 * show why letting software onto a payment rail is defensible, and that is the
 * on-chain allowance. Without it the outer ring is a claim with nothing under
 * it.
 */
const RAILS = [
  {
    name: "PayNow",
    reach: 1,
    stops: "Residents only",
    note: "Free domestically, and genuinely excellent, for the people it can reach.",
    extra: null,
  },
  {
    name: "Cards",
    reach: 2,
    stops: "Residents + tourists",
    note: `Works for a tourist, at around ${CARD_FEE_LABEL} in merchant fees. Cannot serve software.`,
    extra: null,
  },
  {
    name: "Gantry",
    reach: 3,
    stops: "Residents + tourists + agents",
    note: `One integration reaches all three. Software pays over x402, the standard machines already use, and the shop is paid in XSGD minus ${GANTRY_FEE_LABEL}.`,
    extra:
      "Agent spending stays inside on-chain allowances its owner set: daily caps, category allowlists, expiry. Denials are contract reverts, not backend checks.",
  },
] as const;

function ReachPips({ reach }: { reach: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1" aria-hidden>
      {[1, 2, 3].map((band) => (
        <span
          key={band}
          className={cn("size-1.5 rounded-full", band <= reach ? "bg-accent" : "bg-hint")}
        />
      ))}
    </span>
  );
}

export function CoverageDiagram() {
  return (
    <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[minmax(0,360px)_1fr] lg:gap-16">
      {/* Decorative: every fact in here is repeated as text in the rail list, so
          hiding it costs a screen reader nothing and spares it three orphaned
          nouns in the wrong reading order. */}
      <div className="relative mx-auto aspect-square w-full max-w-[360px]" aria-hidden>
        {BANDS.map((band) => (
          <div key={band.name} className={cn("absolute rounded-full", band.inset, band.fill)} />
        ))}
        {BANDS.map((band) => (
          <div
            key={band.name}
            className={cn("absolute -translate-y-1/2 text-center", band.labelInsetX, band.text)}
            style={{ top: band.labelTop }}
          >
            <div className="text-card-title-sm">{band.name}</div>
            {band.sub ? (
              <div className={cn("mt-0.5 text-meta-sm", band.subText)}>{band.sub}</div>
            ) : null}
          </div>
        ))}
      </div>

      <div>
        <ul className="flex flex-col gap-2">
          {RAILS.map((rail) => (
            <li
              key={rail.name}
              className={cn(
                "rounded-control-m px-5.5 py-4.5",
                // Emphasis, not categorical: the row that reaches every band is
                // the point of the panel, the other two are the context it needs.
                rail.reach === 3 ? "bg-accent-tint" : "bg-surface",
              )}
            >
              <div className="flex items-center gap-3">
                <ReachPips reach={rail.reach} />
                <span className="text-card-title-sm">{rail.name}</span>
                <span className="ml-auto text-right text-meta-sm text-muted">{rail.stops}</span>
              </div>
              <p className="mt-1.5 text-body text-quiet">{rail.note}</p>
              {rail.extra ? (
                <p className="mt-2.5 border-t border-accent/12 pt-2.5 text-body text-quiet">
                  {rail.extra}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-meta-sm text-faint">
          Rings are equal width, not to scale. PayNow also reaches countries with a live
          cross-border linkage.
        </p>
      </div>
    </div>
  );
}
