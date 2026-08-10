import { Card } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { GUTTER_X, SEAMS } from "./content";

/**
 * The last thing on the page before the two app doors, and deliberately so.
 *
 * Kept because judges discount a demo that claims everything is real; the
 * credible move is to name the seams before they do. Putting it last means the
 * page ends on the disclosure rather than burying it mid-scroll, and it now
 * qualifies everything above it rather than just the column it used to sit
 * under.
 *
 * Full width does not mean a 150-character measure: the one paragraph is capped
 * at 80ch and everything under it is a grid of five seams, two tracks at `sm`
 * and three at `lg`. See the note on `SEAMS` in content.ts for why they are
 * discrete items rather than prose.
 */
export function SeamsSection() {
  return (
    <section className={cn("pb-20", GUTTER_X)}>
      <Card tone="sunken" radius="card" pad="none" className="px-6 py-6">
        <div className="text-body font-semibold">What isn&apos;t real, said plainly</div>
        {/* The counterweight goes first and stays prose: it is the one claim in
            this panel that asserts something IS real, and listing it beside the
            seams would read as a sixth seam. */}
        <p className="mt-2 max-w-[80ch] text-body-sm text-quiet">
          Payments themselves settle in real Circle USDC: the payer signs an EIP-3009 authorization
          against Circle&apos;s own contract. These are the parts that are not real.
        </p>
        <div className="mt-5 grid gap-x-10 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          {SEAMS.map((seam) => (
            <div key={seam.title}>
              <div className="text-row-title">{seam.title}</div>
              <p className="mt-1 text-meta text-muted">{seam.body}</p>
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}
