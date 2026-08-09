import * as React from "react";
import { cn } from "./cn";

/**
 * A surface. Depth in this system is fill, not elevation — white on paper, then
 * green on white — so a Card is a fill plus a radius plus the padding step that
 * goes with it, and carries no border of its own. (Borders do exist elsewhere:
 * hairline rules inside cards, the sidebar edge, the printed standee's frame.
 * There is exactly one shadow token, `shadow-drawer`, and it is spent only on
 * things that float above the page: the merchant transaction drawer, the phone
 * mock the payer app sits in on desktop, and a toast.)
 */
type CardTone = "surface" | "sunken" | "fill" | "paper" | "accent" | "ink" | "danger";
type CardRadius = "card" | "panel" | "card-m" | "hero" | "control-m" | "tile";
type CardPad = "none" | "list" | "sm" | "m" | "md" | "lg";

const TONE: Record<CardTone, string> = {
  surface: "bg-surface",
  sunken: "bg-surface-sunken",
  fill: "bg-fill-hover", // the inset panel inside a white card (door banner, money in/out)
  paper: "bg-paper",
  accent: "bg-accent text-on-accent",
  ink: "bg-ink text-paper",
  danger: "bg-danger-tint text-danger-deep",
};

const RADIUS: Record<CardRadius, string> = {
  hero: "rounded-hero", // 24
  panel: "rounded-panel", // 20
  "card-m": "rounded-card-m", // 18 — phone
  card: "rounded-card", // 16
  "control-m": "rounded-control-m", // 14 — phone buttons, small cards
  tile: "rounded-tile", // 12
};

const PAD: Record<CardPad, string> = {
  none: "",
  list: "p-2 pb-3", // holds rows, which carry their own 16px inset
  sm: "p-4.5", // 18 — sidebar identity card
  m: "p-5", // 20 — phone cards
  md: "p-6", // 24
  lg: "px-7 py-6.5", // 28 / 26 — KPI panels, wide desktop cards
};

export interface CardProps extends React.ComponentProps<"div"> {
  tone?: CardTone;
  radius?: CardRadius;
  pad?: CardPad;
  /** Whole-card hover fill. Only for cards that are themselves a link or button. */
  hover?: boolean;
  as?: React.ElementType;
}

export function Card({
  tone = "surface",
  radius = "card",
  pad = "md",
  hover = false,
  as,
  className,
  ...props
}: CardProps) {
  const Comp = (as ?? "div") as React.ElementType;
  return (
    <Comp
      className={cn(
        TONE[tone],
        RADIUS[radius],
        PAD[pad],
        hover && "focus-ring cursor-pointer transition-colors hover:bg-fill-hover-card",
        className,
      )}
      {...props}
    />
  );
}
