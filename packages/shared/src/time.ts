/**
 * Every timestamp on the wire is unix SECONDS (see api.ts), while every
 * JavaScript clock hands out milliseconds. A `Date.now()` that slips into one
 * of these helpers is silent and total: an expiry check would call a dead
 * policy active until the year 5138, and a day bucket would land four thousand
 * years from now. So the guard is not defensive noise — it is the one place
 * that mistake can be caught.
 */

/** Roughly year 5138 in seconds; any real ms clock is far above it. */
export const UNIX_SECONDS_CEILING = 100_000_000_000;

/** Throws rather than returning a sentinel: a bad clock has no safe default. */
export function assertUnixSeconds(value: number, label = "timestamp"): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer number of unix seconds, got ${value}`);
  }
  if (value > UNIX_SECONDS_CEILING) {
    throw new Error(`${label} looks like milliseconds, not unix seconds: ${value}`);
  }
  return value;
}
