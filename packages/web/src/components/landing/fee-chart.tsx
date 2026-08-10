import { CARD_FEE_BPS, GANTRY_FEE_BPS } from "@gantry/shared";

/**
 * What each rate costs a shop as its volume grows.
 *
 * Deliberately the SMALLEST of the three visuals on this section, because fees
 * are Gantry's weakest claim and a chart outranks every sentence around it.
 * PayNow is free domestically, 0.5% is a config constant rather than a moat, and
 * the 2.8% is this project's benchmark rather than a sourced industry rate. The
 * page's argument is coverage; this is a footnote to it that happens to be
 * drawable. If it ever grows into the biggest thing here, the page has started
 * making the case we lose.
 *
 * Both series are straight lines through the origin (a fee is a rate), so the
 * subject is really the WEDGE between them — what the shop keeps, widening with
 * volume. See `latency-chart.tsx` for why the accent/gray emphasis pair is
 * correct despite the palette validator's categorical-scope FAILs.
 */

const MAX_VOLUME = 5000;
/** Rounds above cards' S$140 at max volume, so the y ticks stay clean. */
const MAX_FEE = 150;
/** The volume the copy quotes everywhere: a hawker's monthly takings. */
const CALLOUT_VOLUME = 2000;

const PLOT = { left: 48, right: 430, top: 24, bottom: 176 } as const;

const x = (volume: number) => PLOT.left + (volume / MAX_VOLUME) * (PLOT.right - PLOT.left);
const y = (fee: number) => PLOT.bottom - (fee / MAX_FEE) * (PLOT.bottom - PLOT.top);

const feeAt = (bps: number, volume: number) => (volume * bps) / 10_000;

const SERIES = [
  {
    name: "Cards",
    bps: CARD_FEE_BPS,
    stroke: "stroke-muted",
    swatch: "bg-muted",
  },
  {
    name: "Gantry",
    bps: GANTRY_FEE_BPS,
    stroke: "stroke-accent",
    swatch: "bg-accent",
  },
] as const;

const Y_TICKS = [0, 50, 100, 150];
const X_TICKS = [0, CALLOUT_VOLUME, MAX_VOLUME];

const money = (amount: number) => `S$${Math.round(amount)}`;

export function FeeChart() {
  const cardsMax = feeAt(CARD_FEE_BPS, MAX_VOLUME);
  const gantryMax = feeAt(GANTRY_FEE_BPS, MAX_VOLUME);
  const cardsCallout = feeAt(CARD_FEE_BPS, CALLOUT_VOLUME);
  const gantryCallout = feeAt(GANTRY_FEE_BPS, CALLOUT_VOLUME);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {SERIES.map((series) => (
          <span key={series.name} className="flex items-center gap-2 text-meta-sm text-quiet">
            <span className={`size-2 rounded-full ${series.swatch}`} />
            {series.name}
          </span>
        ))}
      </div>

      {/* Scrolls rather than shrinks below 400px. An SVG scales its text with
          its viewBox, so on a 390px phone this chart's 11px ticks would render
          at under 6px — present, unreadable, and worse than an honest scroll.
          400 is where the scaled ticks reach ~8px, and it is deliberately not
          higher: at 460 the scrollbar appeared on a laptop where the chart was
          still perfectly legible, which trades a real regression for a
          hypothetical one. The viewBox is also tall enough to contain the x-axis
          caption at y=214; sizing it to the plot instead crops the caption,
          because the axis band is part of the chart rather than padding under it. */}
      <div className="mt-4 overflow-x-auto">
        <svg
          viewBox="0 0 560 226"
          className="w-full min-w-[400px]"
          role="img"
          aria-label={`Monthly merchant fees by volume. At S$${CALLOUT_VOLUME.toLocaleString()} a month, cards cost ${money(
            cardsCallout
          )} and Gantry costs ${money(gantryCallout)}.`}
        >
          {Y_TICKS.map((tick) => (
            <g key={tick}>
              {/* Solid hairlines, never dashed — a dashed grid reads as a threshold. */}
              <line
                x1={PLOT.left}
                x2={PLOT.right}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-hairline"
                strokeWidth={1}
              />
              <text
                x={PLOT.left - 10}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-faint font-mono text-mono-2xs tabular-nums"
              >
                {money(tick)}
              </text>
            </g>
          ))}

          {/* What the shop keeps. A 10% wash, never a saturated block. */}
          <polygon
            points={`${x(0)},${y(0)} ${x(MAX_VOLUME)},${y(cardsMax)} ${x(MAX_VOLUME)},${y(
              gantryMax
            )}`}
            className="fill-accent/10"
          />

          {SERIES.map((series) => (
            <line
              key={series.name}
              x1={x(0)}
              y1={y(0)}
              x2={x(MAX_VOLUME)}
              y2={y(feeAt(series.bps, MAX_VOLUME))}
              className={series.stroke}
              strokeWidth={2}
              strokeLinecap="round"
            />
          ))}

          {/* The callout: the gap at the volume the copy quotes. */}
          <line
            x1={x(CALLOUT_VOLUME)}
            x2={x(CALLOUT_VOLUME)}
            y1={y(cardsCallout)}
            y2={y(gantryCallout)}
            className="stroke-ink"
            strokeWidth={1}
          />
          <circle
            cx={x(CALLOUT_VOLUME)}
            cy={y(cardsCallout)}
            r={4}
            className="fill-muted stroke-surface"
            strokeWidth={2}
          />
          <circle
            cx={x(CALLOUT_VOLUME)}
            cy={y(gantryCallout)}
            r={4}
            className="fill-accent stroke-surface"
            strokeWidth={2}
          />
          <text
            x={x(CALLOUT_VOLUME) + 12}
            y={(y(cardsCallout) + y(gantryCallout)) / 2 + 4}
            className="fill-ink text-meta-sm"
          >
            {money(cardsCallout - gantryCallout)} a month kept
          </text>

          {/* Values ride the line ends; the legend above carries identity, so
            these stay numbers rather than repeating the series names. */}
          <text
            x={PLOT.right + 10}
            y={y(cardsMax) + 4}
            className="fill-muted font-mono text-mono-2xs tabular-nums"
          >
            {money(cardsMax)}
          </text>
          <text
            x={PLOT.right + 10}
            y={y(gantryMax) + 4}
            className="fill-accent font-mono text-mono-2xs tabular-nums"
          >
            {money(gantryMax)}
          </text>

          {X_TICKS.map((tick) => (
            <text
              key={tick}
              x={x(tick)}
              y={PLOT.bottom + 20}
              textAnchor={tick === 0 ? "start" : tick === MAX_VOLUME ? "end" : "middle"}
              className="fill-faint font-mono text-mono-2xs tabular-nums"
            >
              {tick === 0 ? "S$0" : `S$${tick.toLocaleString()}`}
            </text>
          ))}
          <text
            x={(PLOT.left + PLOT.right) / 2}
            y={PLOT.bottom + 38}
            textAnchor="middle"
            className="fill-faint text-meta-sm"
          >
            Monthly volume taken through the shop
          </text>
        </svg>
      </div>
    </div>
  );
}
