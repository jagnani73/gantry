import * as React from "react";
import { cn } from "./cn";
import { TEXT_TONE, type Tone } from "./tone";
import { formatUnits, type Units } from "./units";

/**
 * The one big number on a screen, with its currency mark.
 *
 * The mark is always two or three steps smaller than the figure, and getting that
 * pairing wrong is the fastest way to make a payments screen look amateur — so
 * the pairing lives here and the size names are the places they appear, not px.
 */
type FigureSize = "entry" | "paid" | "kpi" | "payout" | "balance" | "detail" | "sm";

const FIGURE: Record<FigureSize, string> = {
  entry: "text-entry", // 64 — phone amount pad
  paid: "text-figure-kpi", // 56 — payer success
  kpi: "text-figure-kpi", // 56 — collected today
  payout: "text-figure-lg", // 52 — paid out to date
  balance: "text-figure-balance", // 50 — wallet balance
  detail: "text-figure", // 44 — drawer, receipt, agent detail
  sm: "text-figure-sm", // 40 — secondary KPI
};

const CURRENCY: Record<FigureSize, string> = {
  entry: "text-currency-xl", // 28
  paid: "text-currency-lg", // 24
  kpi: "text-currency", // 22
  payout: "text-currency", // 22
  balance: "text-currency", // 22
  detail: "text-currency-sm", // 20
  sm: "text-currency-sm", // 20
};

type FigureBase = Omit<React.ComponentProps<"div">, "prefix" | "children"> & {
  /** Currency mark. Pass null for a figure that is a count, not money. */
  prefix?: string | null;
  size?: FigureSize;
  tone?: "ink" | "on-accent";
  prefixTone?: Tone;
  /** Trailing text on the same baseline, e.g. "of 14". */
  suffix?: React.ReactNode;
};

export type FigureProps = FigureBase &
  (
    | { units: Units; dp?: number; value?: never }
    /** For figures that are not money — a payment count, a date. */
    | { value: React.ReactNode; units?: never; dp?: never }
  );

export function Figure({
  units,
  value,
  dp = 2,
  prefix = "S$",
  size = "kpi",
  tone = "ink",
  prefixTone,
  suffix,
  className,
  ...props
}: FigureProps) {
  const resolvedPrefixTone: Tone = prefixTone ?? (tone === "on-accent" ? "on-accent-muted" : "muted");
  return (
    <div
      className={cn(
        "flex items-baseline gap-1.75",
        tone === "on-accent" ? "text-on-accent" : "text-ink",
        className,
      )}
      {...props}
    >
      {prefix ? (
        <span className={cn(CURRENCY[size], TEXT_TONE[resolvedPrefixTone])}>{prefix}</span>
      ) : null}
      <span className={cn(FIGURE[size], "tabular-nums")}>
        {units === undefined ? value : formatUnits(units, dp)}
      </span>
      {suffix ? (
        <span
          className={cn("text-body", tone === "on-accent" ? "text-on-accent-body" : "text-muted")}
        >
          {suffix}
        </span>
      ) : null}
    </div>
  );
}
