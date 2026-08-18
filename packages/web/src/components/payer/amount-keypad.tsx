"use client";

import { cn } from "@/components/primitives";

/**
 * The amount pad, and the validation that decides whether the pay button is
 * live.
 *
 * The rules are unchanged from the pay page this replaces, deliberately: at most
 * two decimals (XSGD is 6dp, but a hawker price is not), at most four integer
 * digits, one decimal point, strictly positive. They are exported as pure
 * functions so the same predicate gates the button, the keypad and any test —
 * a screen re-deriving "is this payable" is a screen that can disagree with the
 * button next to it.
 */

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"] as const;

export function isValidAmount(value: string, max: number): boolean {
  return /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0 && Number(value) <= max;
}

/**
 * The same shape rule with no ceiling, for an amount that arrived from OUTSIDE
 * — a merchant's charge link, where the amount is the shop's and the ceiling is
 * the payer's. A link asking for more than this payer may spend still prefills:
 * the existing over-cap notice is the right place to say so, and silently
 * blanking the field would leave someone staring at an empty pad wondering
 * where the price went. Derived from `isValidAmount` rather than restated, so a
 * second regex cannot drift from the one the button trusts.
 */
export function isAmountShape(value: string): boolean {
  return isValidAmount(value, Infinity);
}

/** Pure: current text + a key press → the next text. */
export function pressAmountKey(value: string, key: string): string {
  if (key === "⌫") return value.slice(0, -1);
  if (key === "." && (value.includes(".") || value === "")) return value;
  if (/^\d$/.test(key)) {
    const [, decimals] = value.split(".");
    if (decimals && decimals.length >= 2) return value;
    if (!value.includes(".") && value.replace(/^0+/, "").length >= 4) return value; // caps S$9999
  }
  return value === "0" && key !== "." ? key : value + key;
}

export function AmountKeypad({
  value,
  onChange,
  onSubmit,
  max,
  submitLabel,
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  max: number;
  submitLabel: string;
  disabled?: boolean;
}) {
  const valid = isValidAmount(value, max);
  return (
    <div className="px-3.5 pb-3.5">
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(pressAmountKey(value, key))}
            aria-label={key === "⌫" ? "Delete" : key}
            className="focus-ring h-14.5 rounded-control-m bg-surface text-keypad text-ink transition-colors select-none active:bg-hairline"
          >
            {key}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={!valid || disabled}
        onClick={onSubmit}
        className={cn(
          "focus-ring mt-2.5 h-13.5 w-full rounded-control-m text-btn transition-colors",
          valid && !disabled
            ? "bg-ink text-paper hover:bg-ink-hover"
            : "cursor-not-allowed bg-nav-active text-faintest",
        )}
      >
        {submitLabel}
      </button>
    </div>
  );
}
