/**
 * The one place a semantic tone becomes a colour class.
 *
 * Every primitive takes `tone` rather than a className so that "faint" means the
 * same grey on the merchant table and on the phone receipt. The maps hold whole
 * class strings on purpose — Tailwind scans source text, so a composed name like
 * `text-${tone}` would never be generated.
 */
export type Tone =
  | "ink"
  | "quiet"
  | "muted"
  | "faint"
  | "faintest"
  | "accent"
  | "danger"
  | "danger-deep"
  | "warning"
  | "on-accent"
  | "on-accent-body"
  | "on-accent-muted"
  | "paper"
  | "inherit";

export const TEXT_TONE: Record<Tone, string> = {
  ink: "text-ink",
  quiet: "text-quiet",
  muted: "text-muted",
  faint: "text-faint",
  faintest: "text-faintest",
  accent: "text-accent",
  danger: "text-danger",
  "danger-deep": "text-danger-deep",
  warning: "text-warning",
  "on-accent": "text-on-accent",
  "on-accent-body": "text-on-accent-body",
  "on-accent-muted": "text-on-accent-muted",
  paper: "text-paper",
  inherit: "",
};
