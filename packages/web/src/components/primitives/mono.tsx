import * as React from "react";
import { cn } from "./cn";
import { TEXT_TONE, type Tone } from "./tone";

/**
 * Anything that identifies rather than describes: an address, a tx hash, a block
 * number, a clock time, a handle. Always tabular-nums, so a column of timestamps
 * does not shimmer as the seconds tick.
 */
type MonoSize = "md" | "sm" | "xs" | "2xs" | "3xs" | "4xs";

const SIZE: Record<MonoSize, string> = {
  md: "text-mono", // 12.5 — key/value values, drawer
  sm: "text-mono-sm", // 12 — table cells
  xs: "text-mono-xs", // 11.5 — payer address under a row title
  "2xs": "text-mono-2xs", // 11 — sidebar handle, wallet
  "3xs": "text-mono-3xs", // 10.5 — registration line
  "4xs": "text-mono-4xs", // 10 — standee URL
};

export interface MonoProps extends React.ComponentProps<"span"> {
  size?: MonoSize;
  tone?: Tone;
  /** One line, ellipsised. For a fixed-width cell that must not wrap. */
  truncate?: boolean;
  /** Wrap mid-token. For a full 42-character address in a narrow card. */
  breakAll?: boolean;
}

export function Mono({
  size = "sm",
  tone = "inherit",
  truncate = false,
  breakAll = false,
  className,
  ...props
}: MonoProps) {
  return (
    <span
      className={cn(
        "font-mono tabular-nums",
        SIZE[size],
        TEXT_TONE[tone],
        truncate && "block min-w-0 truncate",
        breakAll && "break-all",
        className,
      )}
      {...props}
    />
  );
}
