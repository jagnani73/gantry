import * as React from "react";
import { cn } from "./cn";

/**
 * Connection and liveness, as a dot.
 *
 * The three tones map to the merchant feed's three states — live / connecting /
 * disconnected — and the dot never travels without its label, because a colour
 * alone cannot say "payments are still settling, this screen just cannot see
 * them".
 */
type StatusTone = "accent" | "warning" | "danger" | "muted";

const FILL: Record<StatusTone, string> = {
  accent: "bg-accent",
  warning: "bg-warning",
  danger: "bg-danger",
  muted: "bg-faint",
};

const RING: Record<StatusTone, string> = {
  accent: "ring-3 ring-accent/15",
  warning: "ring-3 ring-warning/15",
  danger: "ring-3 ring-danger/15",
  muted: "ring-3 ring-faint/15",
};

export interface StatusDotProps extends React.ComponentProps<"span"> {
  tone?: StatusTone;
  /** 6px inline with text, 7px in the settlements header. */
  size?: "sm" | "md";
  /** The soft halo the header dot carries. */
  ring?: boolean;
}

export function StatusDot({
  tone = "accent",
  size = "sm",
  ring = false,
  className,
  ...props
}: StatusDotProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block shrink-0 rounded-full",
        size === "md" ? "size-1.75" : "size-1.5",
        FILL[tone],
        ring && RING[tone],
        className,
      )}
      {...props}
    />
  );
}
