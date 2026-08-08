import * as React from "react";
import { cn } from "./cn";
import { TEXT_TONE, type Tone } from "./tone";

/**
 * The uppercase micro-label above a figure, over a section, or across a table's
 * columns. Tracking is what makes these legible at 10px, so it is baked into the
 * type token rather than left to the caller.
 *
 * `col-header` and the two `eyebrow` sizes are mono — they label data, not prose.
 */
type LabelSize = "lg" | "md" | "wide" | "eyebrow" | "eyebrow-sm" | "col-header";

const SIZE: Record<LabelSize, string> = {
  lg: "text-label-lg", // 12.5 — KPI panel labels
  md: "text-label", // 12 — section labels
  wide: "text-label-wide", // 11.5 / 0.18em — "SCAN TO PAY" on the standee
  eyebrow: "font-mono text-eyebrow", // 10.5 — "FOR SHOPS"
  "eyebrow-sm": "font-mono text-eyebrow-sm", // 9.5 — the MERCHANT / DEMO tags
  "col-header": "font-mono text-col-header", // 10 — table column headers
};

export interface LabelProps extends React.ComponentProps<"div"> {
  size?: LabelSize;
  tone?: Tone;
  as?: React.ElementType;
}

export function Label({
  size = "md",
  tone = "faint",
  as,
  className,
  ...props
}: LabelProps) {
  const Comp = (as ?? "div") as React.ElementType;
  return <Comp className={cn("uppercase", SIZE[size], TEXT_TONE[tone], className)} {...props} />;
}
