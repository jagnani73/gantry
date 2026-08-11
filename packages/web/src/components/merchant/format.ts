import {
  DISPLAY_TIME_ZONE,
  dayKey,
  dayKeyMiddayUnixSeconds,
  relativeDayLabel,
  type DayKey,
  type SettlementEvent,
} from "@gantry/shared";

/**
 * Dates and clocks on the merchant surface, all pinned to Asia/Singapore.
 *
 * The zone is not the browser's. Overview buckets rows against a window
 * boundary computed with `dayKey`, pinned to SGT so a UTC backend and an SGT
 * browser cannot disagree about which side of midnight a payment fell on — and
 * a row timestamp rendered with a LOCAL clock, under a header whose date range
 * was computed in SGT, would reintroduce exactly that disagreement one line
 * lower down.
 *
 * Formatters are constructed once: building an Intl.DateTimeFormat per row is
 * the expensive way to draw a table.
 */

const CLOCK = new Intl.DateTimeFormat("en-SG", {
  timeZone: DISPLAY_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** "5 August" — the "since" in a range that is obviously this year. */
const MONTH_DAY = new Intl.DateTimeFormat("en-SG", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "long",
});

/** "4" — the opening end of a range whose month is written once, at the close. */
const DAY_ONLY = new Intl.DateTimeFormat("en-SG", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
});

/** "8 Aug 2026" — registration dates and the drawer's timestamp. */
const SHORT_DATE = new Intl.DateTimeFormat("en-SG", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "8 Aug" — the day on a Transactions row. */
const TABLE_DAY = new Intl.DateTimeFormat("en-SG", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "short",
});

const COUNT = new Intl.NumberFormat("en-SG");

export function clockTime(unixSeconds: number): string {
  return CLOCK.format(unixSeconds * 1000);
}

/**
 * "14:32" · "Yesterday 14:32" · "6 Aug 14:32" — a feed row's timestamp.
 *
 * The date appears only when the row is NOT from today. Overview's feed used to
 * be a single day, so a bare clock was unambiguous; it now spans a rolling week
 * under a panel headed "Live feed", where a payment from last Tuesday would
 * otherwise read exactly like one that landed a minute ago. Today's rows stay
 * bare, because prefixing every one of them with "Today" is noise on the case
 * that needs no disambiguating.
 */
export function feedWhen(atUnixSeconds: number, nowUnixSeconds: number | null): string {
  const time = clockTime(atUnixSeconds);
  if (nowUnixSeconds === null) return time;
  const label = relativeDayLabel(dayKey(atUnixSeconds), nowUnixSeconds);
  if (label === "Today") return time;
  return `${label ?? monthDay(atUnixSeconds)} ${time}`;
}

/**
 * "4–10 August" — the span the Overview tiles cover.
 *
 * The month is written once when both ends share it, which is the common case
 * for a seven-day window and the difference between a date range and a mouthful
 * ("4 August – 10 August"). Both ends come from DayKeys built from the same
 * clock reading the tiles use, so the header cannot drift from the START day
 * they count. The top end is looser by design — see `rowsInOverviewWindow`.
 */
export function dayRangeLabel(startDay: DayKey, endDay: DayKey): string {
  const start = dayKeyMiddayUnixSeconds(startDay);
  const end = dayKeyMiddayUnixSeconds(endDay);
  if (startDay === endDay) return monthDay(end);
  // Compare the month component of the key itself rather than a formatted
  // string: the keys are already in the display zone, and re-parsing a rendered
  // date to find out what month it was in is how zones get lost.
  const sameMonth = startDay.slice(0, 7) === endDay.slice(0, 7);
  return sameMonth
    ? `${DAY_ONLY.format(start * 1000)}–${monthDay(end)}`
    : `${monthDay(start)} – ${monthDay(end)}`;
}

export function shortDate(unixSeconds: number): string {
  return SHORT_DATE.format(unixSeconds * 1000);
}

/**
 * "8 Aug" — the day above a Transactions row's clock.
 *
 * No year, deliberately, and it is the one place that omission is safe: the
 * drawer and the CSV export both carry `shortDate`, so the full date is one
 * click or one download away, while a year repeated down every row of a book
 * that spans weeks is the noise `feedWhen` avoids for the same reason.
 *
 * Unlike `feedWhen` this does NOT go quiet for today. That rule fits a live
 * feed, where nearly every row is today and a date would be the exception;
 * Transactions is the whole book, where a column the eye scans has to say the
 * same kind of thing on every line.
 */
export function tableDay(unixSeconds: number): string {
  return TABLE_DAY.format(unixSeconds * 1000);
}

export function monthDay(unixSeconds: number): string {
  return MONTH_DAY.format(unixSeconds * 1000);
}

/** Block numbers and payment counts — grouped, because seven digits are not
 * readable as a run. */
export function grouped(value: number): string {
  return COUNT.format(value);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${grouped(count)} ${count === 1 ? singular : pluralForm}`;
}

/** What the merchant actually banks: the gross swap output less the protocol fee. */
export function netOf(row: SettlementEvent): bigint {
  return BigInt(row.xsgdOut) - BigInt(row.feeXsgd);
}

export interface FeedTotals {
  count: number;
  /** Sum of the gross swap outputs — the prices payers paid. */
  gross: bigint;
  fees: bigint;
  net: bigint;
  /** What the same gross would have cost at the card benchmark, less our fee. */
  saved: bigint;
  agentCount: number;
}

export function totalsOf(rows: readonly SettlementEvent[], cardFeeBps: number): FeedTotals {
  let gross = 0n;
  let fees = 0n;
  let agentCount = 0;
  for (const row of rows) {
    gross += BigInt(row.xsgdOut);
    fees += BigInt(row.feeXsgd);
    if (row.door === "agent") agentCount += 1;
  }
  const cardFees = (gross * BigInt(cardFeeBps)) / 10_000n;
  const saved = cardFees - fees;
  return {
    count: rows.length,
    gross,
    fees,
    net: gross - fees,
    // Cards are the dearer rail at every volume, so a negative here would mean
    // the constants were edited into nonsense rather than that a merchant lost
    // money. Clamp instead of rendering "saved −S$0.02".
    saved: saved < 0n ? 0n : saved,
    agentCount,
  };
}

/**
 * The rate this settlement actually cleared at, derived from the amounts on the
 * event: `xsgdOut / amountIn`, in 6dp units per 1e6 token units.
 *
 * Derived rather than read from `DEMO_RATE`, because that constant is the rate
 * the swap was SEEDED with and the owner can change it — a settlement from
 * before a change would then be annotated with a rate it never used.
 *
 * Rounded to the four decimal places it is displayed at, because the quote that
 * produced `amountIn` was CEILED: the implied rate lands a hair below the listed
 * one (1.34209…), and `formatUnits6` truncates, so an unrounded value renders
 * S$4.50 at "1.3420" against a rate the whole demo calls 1.3421.
 */
export function impliedRate(row: SettlementEvent): bigint | null {
  const amountIn = BigInt(row.amountIn);
  if (amountIn <= 0n) return null;
  const raw = (BigInt(row.xsgdOut) * 1_000_000n) / amountIn;
  return ((raw + 50n) / 100n) * 100n;
}
