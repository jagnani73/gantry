import { cn } from "@/components/primitives";

/**
 * A shop's mark, derived from what it is called.
 *
 * There is no logo upload and no blob storage, so the alternative was the
 * design's striped placeholder everywhere — which makes every shop in "Places
 * you've paid" look identical. Initials are deterministic, need no storage, and
 * claim nothing: they are the shop's own name, not a brand asset it never gave
 * us. Neutral fill deliberately — green in this system marks something the chain
 * asserts, and a shop's name is self-attested.
 */

type TileSize = "sm" | "md" | "lg" | "xl";

const SIZE: Record<TileSize, string> = {
  sm: "size-9.5 rounded-row text-mono-2xs", // 38 — list rows
  md: "size-11.5 rounded-tile text-mono-sm", // 46 — the scan result card
  lg: "size-14 rounded-control-m text-mono", // 56 — receipt header
  xl: "size-14.5 rounded-control-m text-mono", // 58 — merchant page
};

export function merchantInitials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

export function MerchantTile({
  name,
  size = "sm",
  className,
}: {
  /** Display name when there is one, otherwise the handle — the caller decides,
   * because only it knows whether the record has finished loading. */
  name: string;
  size?: TileSize;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-fill-subtle font-mono font-medium text-quiet",
        SIZE[size],
        className,
      )}
    >
      {merchantInitials(name)}
    </span>
  );
}
