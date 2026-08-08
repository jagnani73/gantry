import * as React from "react";
import { cn } from "./cn";

/**
 * A small fill carrying one fact: a category, a policy status, the DEMO tag on a
 * demo account, the "locked" marker on a claimed handle.
 *
 * Green is reserved for facts the chain asserts (category, active policy). Neutral
 * is for everything else, which is why "Registered on-chain" is neutral and not a
 * badge of approval — registration is permissionless and self-attested.
 */
type ChipTone = "neutral" | "accent" | "danger" | "warning" | "on-accent" | "on-ink";
type ChipSize = "sm" | "md" | "lg";

const TONE: Record<ChipTone, string> = {
  neutral: "bg-fill-subtle text-quiet",
  accent: "bg-accent-tint text-accent",
  danger: "bg-danger-tint text-danger",
  warning: "bg-fill-subtle text-warning",
  "on-accent": "bg-on-accent/16 text-on-accent", // inside a green panel
  "on-ink": "bg-paper/12 text-paper", // inside an ink panel
};

const SIZE: Record<ChipSize, string> = {
  sm: "px-2.25 py-0.75 rounded-badge text-chip-sm", // 9 / 3, radius 6
  md: "px-2.5 py-1.25 rounded-chip-sm text-chip", // 10 / 5, radius 7
  lg: "px-2.75 py-1.25 rounded-chip text-chip", // 11 / 5, radius 8
};

export interface ChipProps extends React.ComponentProps<"span"> {
  tone?: ChipTone;
  size?: ChipSize;
  /** For tags that read as identifiers — DEMO, locked, a token ticker. */
  mono?: boolean;
}

export function Chip({
  tone = "neutral",
  size = "md",
  mono = false,
  className,
  ...props
}: ChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        TONE[tone],
        SIZE[size],
        mono && "font-mono",
        className,
      )}
      {...props}
    />
  );
}
