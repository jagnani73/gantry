/**
 * When the shop's money actually arrives: two bars, and the ratio between them.
 *
 * There is deliberately NO AXIS here, and that is the honest choice rather than
 * a lazy one. The two durations are 43,000x apart, so no scale works: linear
 * makes Gantry's bar a sub-pixel sliver, and a log axis (which this chart used
 * to have) is worse than useless on bar LENGTH, because a reader decodes bar
 * length as proportion and would read a 16x-longer bar as 16x-longer time.
 *
 * With no axis there is no scale to misread. The bars say "short" and "long",
 * the labels carry the real quantities, and the ratio between them carries the
 * claim. The caption states that the bars are not to scale, for the same reason
 * the Euler rings say they are not to scale — the alternative is letting a
 * reader infer a number we never measured.
 *
 * Emphasis form: Gantry in the accent hue, the comparison in the de-emphasis
 * gray. Both clear 3:1 against the white card, which is what matters here —
 * each bar is read against the surface, not against the other one, and the
 * quantity each stands for is printed beside it in text. Do not "fix" the pair
 * for chroma: this design system is low-chroma throughout, so every available
 * pair would fail that check and the only way to pass it is to invent a hue
 * that belongs to no other surface.
 */

const SECONDS_PER_DAY = 24 * 60 * 60;

/** One Base block. The claim is the same transaction; this is its cost in time. */
const GANTRY_SECONDS = 2;

/**
 * Measured to T+1, the EARLIEST a card settles — the conservative end of the
 * range. Quoting the T+3 figure would treble the number by choosing the
 * comparison's worst case for the other side.
 */
const RATIO = Math.round(SECONDS_PER_DAY / GANTRY_SECONDS / 1000) * 1000;

/**
 * Short enough to read as "barely anything", wide enough to still be a bar and
 * not a dot at phone widths. It is not 1/43000 of the other one, which is the
 * whole reason the caption exists.
 */
const GANTRY_BAR_WIDTH = "5%";

function Bar({
  figure,
  detail,
  width,
  fill,
}: {
  figure: string;
  detail: string;
  width: string;
  fill: string;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-title-sm text-ink">{figure}</span>
        <span className="text-meta-sm text-muted">{detail}</span>
      </div>
      <div className={`mt-2.5 h-2.5 rounded-full ${fill}`} style={{ width }} />
    </div>
  );
}

export function LatencyChart() {
  return (
    <div className="flex flex-1 flex-col justify-center gap-6">
      <Bar
        figure="~2 seconds"
        detail="Gantry · same transaction"
        width={GANTRY_BAR_WIDTH}
        fill="bg-accent"
      />

      {/* Between the bars, because the gap between them is what it measures. */}
      <div className="flex items-center gap-3.5">
        <span className="h-px flex-1 bg-hairline" />
        <span className="shrink-0 text-card-title-sm text-ink">
          {RATIO.toLocaleString()}× longer
        </span>
        <span className="h-px flex-1 bg-hairline" />
      </div>

      <Bar
        figure="1–3 days"
        detail="Cards · T+1 to T+3"
        width="100%"
        fill="bg-muted"
      />
    </div>
  );
}
