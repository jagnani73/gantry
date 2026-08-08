import * as React from "react";
import type { WireDoor } from "@gantry/shared";
import { cn } from "./cn";

/**
 * Which door a payment came through, as two glyphs.
 *
 * This is the one mark that appears on every surface — merchant feed, merchant
 * table, drawer, payer history, receipt — so it is a component rather than a
 * convention. `declined` is not a door: it is an agent payment the wallet
 * contract refused, and it has to be visually unmistakable from a settled one
 * because the two sit in the same list.
 */
export type DoorKind = WireDoor | "declined";

type DoorChipVariant = "tile-34" | "tile-36" | "tile-38" | "pill" | "pill-lg";

const GLYPH: Record<DoorKind, string> = { agent: "AI", human: "QR", declined: "✕" };

/** Short label for the pill form; screens own the longer "Agent · x402" copy. */
export const DOOR_LABEL: Record<DoorKind, string> = {
  agent: "Agent",
  human: "Human",
  declined: "Declined",
};

const COLOUR: Record<DoorKind, string> = {
  agent: "bg-accent-tint text-accent",
  human: "bg-fill-subtle text-quiet",
  declined: "bg-danger-tint text-danger",
};

const VARIANT: Record<DoorChipVariant, string> = {
  "tile-34": "size-8.5 rounded-nav font-mono text-mono-2xs font-medium",
  "tile-36": "size-9 rounded-nav font-mono text-mono-2xs font-medium",
  "tile-38": "size-9.5 rounded-row font-mono text-mono-2xs font-medium",
  pill: "px-2.25 py-0.75 rounded-badge text-chip-sm",
  "pill-lg": "px-2.75 py-1.25 rounded-chip text-chip",
};

export interface DoorChipProps extends React.ComponentProps<"span"> {
  door: DoorKind;
  variant?: DoorChipVariant;
}

export function DoorChip({
  door,
  variant = "tile-34",
  className,
  children,
  ...props
}: DoorChipProps) {
  const isTile = variant.startsWith("tile");
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        COLOUR[door],
        VARIANT[variant],
        className,
      )}
      {...props}
    >
      {children ?? (isTile ? GLYPH[door] : DOOR_LABEL[door])}
    </span>
  );
}
