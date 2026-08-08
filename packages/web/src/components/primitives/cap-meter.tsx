import * as React from "react";
import { cn } from "./cn";
import { formatUnits, percentOf, type Units } from "./units";

/**
 * How much of an on-chain allowance is gone.
 *
 * Used for an agent's daily cap and for the merchant's agent-share KPI. The
 * figure it draws is a chain read, so the bar must never be the only thing on
 * screen — every caller pairs it with the numbers underneath.
 */
type CapMeterTone = "accent" | "danger" | "on-accent";

const TRACK: Record<CapMeterTone, string> = {
  accent: "bg-fill-subtle",
  danger: "bg-fill-subtle",
  "on-accent": "bg-on-accent/20", // sits inside the green panel
};

const FILL: Record<CapMeterTone, string> = {
  accent: "bg-accent",
  danger: "bg-danger",
  "on-accent": "bg-on-accent",
};

export interface CapMeterProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** 6dp units already spent. */
  spent: Units;
  /** 6dp units allowed. Zero (a revoked policy) reads as an empty bar. */
  cap: Units;
  tone?: CapMeterTone;
  /** 5px on cards, 6px inside the green agent panel. */
  height?: "sm" | "md";
}

export function CapMeter({
  spent,
  cap,
  tone = "accent",
  height = "sm",
  className,
  ...props
}: CapMeterProps) {
  const percent = percentOf(spent, cap);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={`${formatUnits(spent)} of ${formatUnits(cap)} spent`}
      className={cn(
        "w-full overflow-hidden rounded-full",
        height === "md" ? "h-1.5" : "h-1.25",
        TRACK[tone],
        className,
      )}
      {...props}
    >
      <div
        className={cn("h-full rounded-full transition-[width]", FILL[tone])}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
