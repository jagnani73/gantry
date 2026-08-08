"use client";

import type { ReactNode } from "react";
import { cn } from "@/components/primitives";

/**
 * A full-screen step that sits over the tabs — scan, the pay flow, a receipt, a
 * shop, an agent.
 *
 * Drawn at 402px in the design and built here as a normal responsive page: the
 * iPhone bezel in the prototype was presentation scaffolding. On a wide screen
 * the column stays phone-width and the tone bleeds to the edges, so a green
 * success screen still reads as one surface rather than a card floating on
 * paper.
 */

type OverlayTone = "paper" | "ink" | "accent";

const TONE: Record<OverlayTone, string> = {
  paper: "bg-paper text-ink",
  ink: "bg-ink text-paper",
  accent: "bg-accent text-on-accent",
};

export function OverlayScreen({
  tone = "paper",
  children,
  className,
}: {
  tone?: OverlayTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("fixed inset-0 z-30 flex justify-center", TONE[tone])}>
      <div
        className={cn(
          "animate-overlay-push flex h-full w-full max-w-md flex-col overflow-y-auto",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

const BACK_TONE: Record<OverlayTone, string> = {
  paper: "bg-hairline-strong text-quiet hover:bg-nav-active focus-ring",
  ink: "bg-paper/12 text-paper hover:bg-paper/20 focus-ring-inverse",
  accent: "bg-on-accent/14 text-on-accent hover:bg-on-accent/22 focus-ring-inverse",
};

const TITLE_TONE: Record<OverlayTone, string> = {
  paper: "text-ink",
  ink: "text-paper",
  accent: "text-on-accent",
};

const SUBTITLE_TONE: Record<OverlayTone, string> = {
  paper: "text-muted",
  ink: "text-paper/60",
  accent: "text-on-accent-body",
};

export function OverlayHeader({
  onBack,
  backLabel,
  glyph = "‹",
  title,
  subtitle,
  tone = "paper",
}: {
  onBack: () => void;
  /** Screen-reader wording — "‹" and "✕" say nothing out loud. */
  backLabel: string;
  glyph?: "‹" | "✕";
  title?: ReactNode;
  subtitle?: ReactNode;
  tone?: OverlayTone;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-15.5">
      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel}
        className={cn(
          "flex size-8.5 shrink-0 items-center justify-center rounded-nav text-body-lg transition-colors",
          BACK_TONE[tone],
        )}
      >
        {glyph}
      </button>
      <div className="min-w-0 text-center">
        {title ? (
          <div className={cn("truncate text-card-title-xs", TITLE_TONE[tone])}>{title}</div>
        ) : null}
        {subtitle ? (
          <div className={cn("truncate text-fine", SUBTITLE_TONE[tone])}>{subtitle}</div>
        ) : null}
      </div>
      {/* Balances the back button so the title stays optically centred. */}
      <span className="size-8.5 shrink-0" aria-hidden />
    </div>
  );
}
