import { cn } from "@/lib/utils";

/**
 * A shop's mark, derived from its own name.
 *
 * Logo upload is deliberately not built — it would mean blob storage, a moderation
 * question and an upload endpoint, for a field that appears at 52px. So the tile
 * is deterministic: the same shop draws the same mark on every surface with no
 * state anywhere. A shop with nothing to derive from falls back to the striped
 * empty slot the design system defines once in globals.css.
 */
const SIZE = {
  // 88 — the profile editor, but only below `sm`, where the tile sits on its own
  // line. From `sm` up that screen overrides this with `sm:size-auto
  // sm:aspect-square` and the tile takes its height from the field stack beside
  // it, so 88 is the narrow-viewport case rather than the size it usually draws.
  lg: "size-22 rounded-control-m text-card-title",
  xl: "size-15.5 rounded-control-m text-card-title-sm", // 62 — the directory drawer
  md: "size-13 rounded-tile text-card-title-xs", // 52 — the payer preview, directory card
} as const;

export function initialsOf(name: string): string {
  const words = name
    .split(/[\s-_]+/)
    .filter((word) => /\p{L}|\p{N}/u.test(word))
    .slice(0, 2);
  return words.map((word) => [...word][0]?.toUpperCase() ?? "").join("");
}

export function ShopTile({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const initials = initialsOf(name);
  return (
    <div
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center",
        SIZE[size],
        initials === "" ? "stripe-placeholder" : "bg-accent-tint text-accent",
        className,
      )}
    >
      {initials}
    </div>
  );
}
