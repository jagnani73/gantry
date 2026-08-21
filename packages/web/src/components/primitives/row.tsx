import * as React from "react";
import { cn } from "./cn";

/**
 * One line in a list, on either surface.
 *
 * Layout is the caller's (the merchant table is a 6-column grid, the phone list
 * is a flex line); what Row owns is the part that must not drift: the 11px
 * radius, the hover fill, a focus ring when it is clickable, and the one-shot
 * tint a settlement gets the moment it lands.
 */
type RowDivider = "hairline" | "paper" | "subtle";
type RowPad = "none" | "row" | "tight" | "list";

const DIVIDER: Record<RowDivider, string> = {
  hairline: "border-b border-hairline", // inside a white card, desktop
  paper: "border-b border-paper", // inside a white card, phone lists
  subtle: "border-b border-fill-subtle", // under a table's column headers
};

const PAD: Record<RowPad, string> = {
  none: "",
  row: "px-4 py-3.25", // 16 / 13 — merchant feed
  tight: "px-4 py-3", // 16 / 12 — merchant table
  list: "py-3.5", // 14 vertical only — phone rows sit inside a padded card
};

export interface RowProps extends React.ComponentProps<"div"> {
  pad?: RowPad;
  divider?: RowDivider;
  /** Hover fill, pointer, focus ring. Renders a <button> unless `as` says otherwise. */
  interactive?: boolean;
  /**
   * A row that just arrived. One-shot accent tint rather than a border, because a
   * border would change the row's height and shove the rest of the feed down.
   * The tint holds and then decays over ten seconds — see `@utility fresh-tint`,
   * which owns the layer, the timing and the reduced-motion form. The caller
   * decides how long the flag stays on, and must not take it off early: the
   * animation is not restartable, so a row stripped mid-decay snaps clear.
   */
  highlight?: boolean;
  as?: React.ElementType;
}

export function Row({
  pad = "row",
  divider,
  interactive = false,
  highlight = false,
  as,
  className,
  ...props
}: RowProps) {
  const Comp = (as ?? (interactive ? "button" : "div")) as React.ElementType;
  return (
    <Comp
      {...(Comp === "button" ? { type: "button" as const } : {})}
      className={cn(
        "rounded-row",
        PAD[pad],
        divider && DIVIDER[divider],
        interactive &&
          "focus-ring w-full cursor-pointer text-left transition-colors hover:bg-fill-hover",
        highlight && "fresh-tint",
        className,
      )}
      {...props}
    />
  );
}
