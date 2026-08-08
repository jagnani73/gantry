import { assertUnixSeconds } from "./time";

/**
 * Calendar-day bucketing for the settlement and denial feeds.
 *
 * The zone is PINNED, not read from the runtime. The merchant's "today's
 * takings" figure may be computed on a host that runs in UTC while the browser
 * grouping the very same rows runs in SGT — between 00:00 and 08:00 SGT those
 * two disagree about which day a payment belongs to, and the day header would
 * then contradict the total sitting above it. One zone for both surfaces, and
 * it is the merchant's, because the day a hawker means is theirs.
 *
 * This is a DISPLAY boundary and nothing else. The agent's daily cap rolls on
 * the contract's `block.timestamp / 1 days` — UTC days, i.e. 08:00 SGT — so
 * never explain one with the other or derive one from the other.
 */
export const DISPLAY_TIME_ZONE = "Asia/Singapore";

/** `YYYY-MM-DD` in a fixed zone. Lexical order is chronological order, which is
 * why it is a string and not a Date. */
export type DayKey = string;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Formatters are immutable and expensive to construct — one per zone, kept,
// because grouping a page of rows would otherwise build one per row. The locale
// pins the Gregorian calendar and latin digits so a host's default locale can
// never change what a day key looks like.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatters.set(timeZone, created);
  return created;
}

/** Unix seconds → the calendar day it falls on in `timeZone`. */
export function dayKey(unixSeconds: number, timeZone: string = DISPLAY_TIME_ZONE): DayKey {
  assertUnixSeconds(unixSeconds, "blockTime");
  const parts = formatterFor(timeZone).formatToParts(unixSeconds * 1000);
  const field = (type: Intl.DateTimeFormatPartTypes, width: number): string =>
    (parts.find((part) => part.type === type)?.value ?? "").padStart(width, "0");
  return `${field("year", 4)}-${field("month", 2)}-${field("day", 2)}`;
}

/**
 * Calendar arithmetic, not `now - 86400`: subtracting a day's worth of seconds
 * lands on the wrong date around a DST shift, and month, year and leap-day
 * rollover are things `Date.UTC` already knows. (Singapore has no DST, but this
 * helper takes a zone and the bug would be invisible until it wasn't.)
 */
export function previousDayKey(day: DayKey): DayKey {
  const match = DAY_KEY.exec(day);
  if (!match) throw new Error(`invalid day key: ${JSON.stringify(day)}`);
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1));
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1, 2)}-${pad(utc.getUTCDate(), 2)}`;
}

/**
 * The two labels every feed needs, and only those. null means "older than
 * yesterday" — format that date however the screen wants; the shared part is
 * where the boundary falls, not how a date reads.
 */
export function relativeDayLabel(
  day: DayKey,
  nowUnixSeconds: number,
  timeZone: string = DISPLAY_TIME_ZONE,
): "Today" | "Yesterday" | null {
  const today = dayKey(nowUnixSeconds, timeZone);
  if (day === today) return "Today";
  return day === previousDayKey(today) ? "Yesterday" : null;
}

export interface DayGroup<T> {
  day: DayKey;
  rows: T[];
}

/**
 * Groups rows without reordering them: groups come out in first-appearance
 * order and rows keep their relative order inside one. Feed it a newest-first
 * page and you get newest-first day sections for free; feed it something else
 * and you get exactly what you asked for, which is the point — sorting here
 * would quietly disagree with whatever ordering the caller had already chosen.
 * Rows for the same day that are not adjacent still land in one group.
 */
export function groupByDay<T>(
  rows: readonly T[],
  at: (row: T) => number,
  timeZone: string = DISPLAY_TIME_ZONE,
): DayGroup<T>[] {
  const groups = new Map<DayKey, T[]>();
  for (const row of rows) {
    const key = dayKey(at(row), timeZone);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return [...groups].map(([day, grouped]) => ({ day, rows: grouped }));
}
