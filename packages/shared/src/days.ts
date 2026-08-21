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
 * bug would be invisible until it wasn't.)
 */
export function previousDayKey(day: DayKey): DayKey {
  const match = DAY_KEY.exec(day);
  if (!match) throw new Error(`invalid day key: ${JSON.stringify(day)}`);
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1));
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1, 2)}-${pad(utc.getUTCDate(), 2)}`;
}

/**
 * `days` calendar days before `day`.
 *
 * Walks back through `previousDayKey` rather than converting to an instant and
 * subtracting `days × 86400`: month, year and leap-day rollover are things the
 * calendar already knows, and a DayKey carries no zone to convert through
 * safely. The three rollovers are pinned in `days.test.ts` because none of them
 * is reachable from a demo day's data — a shop trading inside one month
 * exercises exactly none of this.
 */
export function minusDaysKey(day: DayKey, days: number): DayKey {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`days must be a non-negative integer, got ${JSON.stringify(days)}`);
  }
  let cursor = day;
  for (let left = days; left > 0; left -= 1) cursor = previousDayKey(cursor);
  return cursor;
}

/**
 * A DayKey back into an instant, for handing to a date formatter.
 *
 * MIDDAY UTC, not midnight, and that is the whole point of the function. A
 * DayKey carries no zone, so the only way to render one is to pick an instant
 * inside it; midnight UTC is inside the day for zones east of UTC and inside
 * the PREVIOUS one for every zone west of it, so a formatter would silently
 * render the wrong date. Noon is inside the named day for every zone from
 * UTC-12 through UTC+11; at UTC+12 and further east it lands on the following
 * day. Safe here because every caller formats in `DISPLAY_TIME_ZONE` (UTC+8) —
 * a caller that formats in a zone it was handed must not use this.
 */
export function dayKeyMiddayUnixSeconds(day: DayKey): number {
  const match = DAY_KEY.exec(day);
  if (!match) throw new Error(`invalid day key: ${JSON.stringify(day)}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) / 1000;
}

/**
 * How far `timeZone` runs ahead of UTC at a given instant, in seconds.
 *
 * Read off `Intl` rather than hardcoded, even though `DISPLAY_TIME_ZONE` is
 * UTC+8 with no DST: the offset is derived by formatting the instant in the zone
 * and reading the result back as if it were UTC, so it stays right for whatever
 * zone a caller passes. The `hour12: false` guard is real — some ICU versions
 * render midnight as hour 24 under that flag, which would push the offset a full
 * day out.
 */
function zoneOffsetSeconds(unixSeconds: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(unixSeconds * 1000);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const hour = field("hour") % 24;
  const asIfUtc =
    Date.UTC(field("year"), field("month") - 1, field("day"), hour, field("minute"), field("second")) /
    1000;
  return asIfUtc - unixSeconds;
}

/**
 * The instant a DayKey BEGINS, as unix seconds — the bound a range query needs.
 *
 * `dayKeyMiddayUnixSeconds` above is for formatting and is deliberately not this:
 * it lands somewhere inside the day, which is all a formatter needs and is
 * exactly wrong as the lower edge of a window. This one is the edge, so a
 * `block_time >= ?` filter on the server buckets rows into the same days the
 * browser groups them into.
 *
 * Resolved TWICE against the zone offset. The first pass converts the day's
 * midnight-read-as-UTC using the offset at that naive instant, which is the
 * offset on the wrong side of a DST boundary for the handful of days a year
 * where the two differ; the second pass re-reads it at the corrected instant.
 * Singapore has no DST so both passes always agree here — but this function
 * takes a zone, and a caller passing one that does have DST would otherwise get
 * a window edge an hour out with nothing to show for it.
 */
export function dayKeyStartUnixSeconds(day: DayKey, timeZone: string = DISPLAY_TIME_ZONE): number {
  const match = DAY_KEY.exec(day);
  if (!match) throw new Error(`invalid day key: ${JSON.stringify(day)}`);
  const naive = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000;
  const firstPass = naive - zoneOffsetSeconds(naive, timeZone);
  return naive - zoneOffsetSeconds(firstPass, timeZone);
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
