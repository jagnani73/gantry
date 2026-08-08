import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge cannot tell `text-body` (a size) from `text-muted` (a colour):
 * it classifies any unrecognised `text-*` as a colour, so merging the two drops
 * the size. With the whole type scale living on custom role names, a stock `cn`
 * silently strips the font size off every component that takes a `className` —
 * `twMerge("text-mono", "text-faint")` returns just `text-faint`.
 *
 * So teach it the one thing it cannot infer: which `text-*` names are colours.
 * Everything after `text-` is a size. The negative list is deliberate — the
 * colour table is closed and rarely changes while the type scale grows, and a
 * missing entry here would be a font size vanishing at a call site nobody would
 * think to look at.
 */
const COLOUR_TOKENS = [
  // Surfaces and fills
  "paper",
  "surface",
  "surface-sunken",
  "fill-subtle",
  "fill-hover",
  "fill-hover-card",
  "fill-hover-strong",
  "hairline",
  "hairline-strong",
  "nav-active",
  "nav-hover",
  // Text ladder
  "ink",
  "ink-hover",
  "quiet",
  "muted",
  "faint",
  "faintest",
  "hint",
  "tab-idle",
  // Accent
  "accent",
  "accent-hover",
  "accent-soft",
  "accent-tint",
  "on-accent",
  "on-accent-muted",
  "on-accent-body",
  // Danger and warning
  "danger",
  "danger-tint",
  "danger-tint-hover",
  "danger-deep",
  "warning",
];

const isNotColourToken = (value: string) => !COLOUR_TOKENS.includes(value);

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [isNotColourToken] }],
      rounded: [
        {
          rounded: [
            "hero",
            "panel",
            "card-m",
            "card",
            "control-m",
            "tile",
            "row",
            "nav",
            "control",
            "chip",
            "chip-sm",
            "badge",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
