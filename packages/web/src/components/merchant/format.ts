import { DISPLAY_TIME_ZONE, type SettlementEvent } from "@gantry/shared";

/**
 * Dates and clocks on the merchant surface, all pinned to Asia/Singapore.
 *
 * The zone is not the browser's. The KPI grid buckets rows with `dayKey`, which
 * is pinned to SGT so a UTC backend and an SGT browser cannot disagree about
 * "today" — and a row rendered with a LOCAL clock underneath an SGT day header
 * would reintroduce exactly that disagreement one line lower down.
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

/** "Thursday, 8 August" — the settlements header's date line. */
const LONG_DATE = new Intl.DateTimeFormat("en-SG", {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** "5 August" — the "since" in a range that is obviously this year. */
const MONTH_DAY = new Intl.DateTimeFormat("en-SG", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "long",
});

/** "8 Aug 2026" — registration dates and the drawer's timestamp. */
const SHORT_DATE = new Intl.DateTimeFormat("en-SG", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

const COUNT = new Intl.NumberFormat("en-SG");

export function clockTime(unixSeconds: number): string {
  return CLOCK.format(unixSeconds * 1000);
}

export function longDate(unixSeconds: number): string {
  return LONG_DATE.format(unixSeconds * 1000);
}

export function shortDate(unixSeconds: number): string {
  return SHORT_DATE.format(unixSeconds * 1000);
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
