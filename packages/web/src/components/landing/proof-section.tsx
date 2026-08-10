import { Card, Figure, Label } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { GUTTER_X } from "./content";
import { CoverageDiagram } from "./coverage-diagram";
import { FeeChart } from "./fee-chart";
import { LatencyChart } from "./latency-chart";

/**
 * The case for the rail, in the order the claims are actually strong.
 *
 * Coverage first and largest, because "the payers PayNow cannot reach" is the
 * thesis and it carries the judging weight (Real-World Impact, Innovation, Track
 * Relevance). Settlement timing second, because it is structural rather than a
 * number we chose. Fees LAST and smallest — see the note in `fee-chart.tsx` for
 * why leading with them would argue the case we lose.
 *
 * Every comparison figure on this page that is a benchmark rather than a
 * measurement is footnoted where it is drawn, not in a page-level disclaimer. A
 * chart asserts far louder than the sentence beside it, so the qualifier has to
 * be inside the same card as the mark it qualifies.
 */
export function ProofSection() {
  return (
    <section id="who-can-pay" className={cn("pb-20", GUTTER_X)}>
      <h2 className="text-section">Who can pay</h2>
      <p className="mt-2 max-w-[68ch] text-body text-muted">
        PayNow is free and genuinely excellent, for the people it can reach. The gap is everyone
        else.
      </p>

      {/* Sunken, so the diagram's innermost region — the lightest step of its
          ramp — has a surface to be lighter than. See `coverage-diagram.tsx`. */}
      <Card tone="sunken" radius="hero" pad="none" className="mt-6.5 p-7 md:p-11">
        <CoverageDiagram />
      </Card>

      {/* The two cards stretch to a common height, and the latency card absorbs
          the difference INSIDE its chart (the bars block is `flex-1` and centres
          itself) rather than letting it pool as a hole above the footnote. That
          is why this grid does not use `items-start`: the shorter card has
          somewhere for the slack to go. */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card radius="card" pad="none" className="flex flex-col p-7">
          <Label>When the shop is paid</Label>
          <p className="mt-3 text-body-lg text-quiet">
            <span className="text-ink">GantryCore pays the merchant inside the same transaction</span>{" "}
            that takes the payer&apos;s money. There is no payout batch to wait for, because there
            is no payout step.
          </p>
          <div className="mt-7 flex flex-1 flex-col">
            <LatencyChart />
          </div>
          <p className="mt-7 text-meta-sm text-faint">
            Bars not to scale. Gantry&apos;s side is structural: one transaction, one Base block.
            T+1 to T+3 is a benchmark, not a measurement.
          </p>
        </Card>

        <Card radius="card" pad="none" className="flex flex-col p-7">
          <Label>What it costs the shop</Label>
          <p className="mt-3 text-body-lg text-quiet">
            <span className="text-ink">0.5%, skimmed on-chain in the settling transaction</span>. It
            is not a published price we could quietly move. The gap widens with whatever the shop
            actually takes.
          </p>
          <div className="mt-7">
            <FeeChart />
          </div>
          <p className="mt-7 text-meta-sm text-faint">
            Rate only: excludes cards&apos; fixed per-transaction fee and our relayer&apos;s gas.
            2.8% is this project&apos;s benchmark, not an audited figure.
          </p>
        </Card>
      </div>

      {/* A stat, not a chart: one number with no second series to compare it to.
          Merchant acquiring takes "days to weeks", which is true and would make
          a fine second bar, but we have no sourced figure for it and this page
          does not invent comparisons. The number stands on its own because it is
          performed live in the demo. */}
      <Card
        tone="sunken"
        radius="card"
        pad="none"
        className="mt-5 flex flex-col gap-5 px-7 py-6.5 sm:flex-row sm:items-center sm:gap-10"
      >
        <div className="shrink-0">
          <Label>Time to start accepting</Label>
          <Figure prefix={null} size="sm" value="2 min" className="mt-2.5" />
        </div>
        <p className="max-w-[62ch] text-body-lg text-quiet">
          One form (handle, payout address, category), and the shop is registered on-chain and
          printing its QR. No terminal, no underwriting, no bank visit. We do it on stage, for a
          shop that did not exist when the demo started.
        </p>
      </Card>
    </section>
  );
}
