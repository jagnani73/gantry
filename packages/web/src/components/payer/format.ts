import {
  DISPLAY_TIME_ZONE,
  dayKey,
  formatUnits6,
  relativeDayLabel,
  type DayKey,
} from "@gantry/shared";

/**
 * Payer-side formatting that is not general enough to live in `@gantry/shared`
 * but must not be re-typed per screen: the same instant has to read identically
 * on a wallet row, an activity group and a receipt.
 */

const ONE = 1_000_000n;

/**
 * Token 6dp units → XSGD 6dp units at the FixedRateSwap rate.
 *
 * The rate is OWNER-SET — one address can change it and nothing arbitrages it —
 * so every figure this produces has to be labelled as a demo conversion at the
 * point it is rendered. It is not a market price and must never be presented as
 * one.
 */
export function sgdUnits(tokenUnits: bigint, rate: bigint): bigint {
  return (tokenUnits * rate) / ONE;
}

/** "1.3421". A rate reads as a price, so four places — never the raw six. */
export function formatRate(rate: bigint): string {
  return formatUnits6(rate, 4);
}

/**
 * The rate a SETTLED payment actually got, derived from its own two amounts.
 *
 * `SettlementEvent` carries no rate, and today's `rateOf` is the wrong number
 * for a row from yesterday — it would restate history at whatever the owner has
 * set since. Deriving it from the row keeps the receipt internally consistent:
 * the two amounts above it multiply out to exactly this.
 *
 * Rounds rather than truncates, and that is load-bearing. `amountIn` was CEILed
 * when the intent was quoted (a floored quote reverts InsufficientOutput), so
 * the quotient lands a hair under the pinned rate and a truncated four-place
 * render of 1.3421 prints 1.3420.
 */
export function effectiveRate(amountIn: bigint, xsgdOut: bigint): bigint | null {
  if (amountIn <= 0n) return null;
  return (xsgdOut * ONE + amountIn / 2n) / amountIn;
}

// Formatters are expensive to build and immutable once built, so they are
// module-level rather than per-row: an activity page constructs one, not fifty.
// The zone is pinned to the display zone for the same reason `dayKey` pins it —
// a row's clock time and the day header above it must agree.
const CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const SHORT_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "short",
});

/** A DayKey is already a calendar date in the display zone. Re-formatting it
 * through a zone-aware formatter would shift it by the offset a second time, so
 * it is read back as UTC midnight. */
const DAY_KEY_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});

export function clockTime(atUnixSeconds: number): string {
  return CLOCK.format(atUnixSeconds * 1000);
}

/** "Today 14:22" · "Yesterday 13:41" · "6 Aug 08:30". */
export function relativeWhen(atUnixSeconds: number, nowUnixSeconds: number): string {
  const label = relativeDayLabel(dayKey(atUnixSeconds), nowUnixSeconds);
  return `${label ?? SHORT_DATE.format(atUnixSeconds * 1000)} ${clockTime(atUnixSeconds)}`;
}

/** The heading over a day group: "Today", "Yesterday", or "6 Aug". */
export function dayHeading(day: DayKey, nowUnixSeconds: number): string {
  const label = relativeDayLabel(day, nowUnixSeconds);
  if (label) return label;
  const [year, month, date] = day.split("-").map(Number);
  return DAY_KEY_DATE.format(Date.UTC(year!, month! - 1, date!));
}

/** "8 Aug 2026" — a date with no time, for an expiry or a first visit. */
export function calendarDate(atUnixSeconds: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(atUnixSeconds * 1000);
}
