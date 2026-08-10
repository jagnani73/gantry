import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISPLAY_TIME_ZONE,
  dayKey,
  dayKeyMiddayUnixSeconds,
  groupByDay,
  previousDayKey,
  relativeDayLabel,
  minusDaysKey,
} from "./days";

const seconds = (...utc: [number, number, number, number?, number?, number?]): number =>
  Date.UTC(utc[0], utc[1] - 1, utc[2], utc[3] ?? 0, utc[4] ?? 0, utc[5] ?? 0) / 1000;

test("the day boundary is Singapore midnight, not the host's", () => {
  // 16:00Z is 00:00 SGT the next day — the window where a UTC server and an
  // SGT browser would otherwise file the same payment under different days.
  assert.equal(dayKey(seconds(2026, 8, 7, 15, 59, 59)), "2026-08-07");
  assert.equal(dayKey(seconds(2026, 8, 7, 16, 0, 0)), "2026-08-08");
});

test("day keys are zero-padded so they sort chronologically", () => {
  assert.equal(dayKey(seconds(2026, 1, 5, 4, 0, 0)), "2026-01-05");
  assert.deepEqual(
    ["2026-01-05", "2026-08-07", "2026-08-08"].slice().sort(),
    ["2026-01-05", "2026-08-07", "2026-08-08"],
  );
});

test("an explicit zone is honoured", () => {
  const instant = seconds(2026, 8, 7, 16, 0, 0);
  assert.equal(dayKey(instant, DISPLAY_TIME_ZONE), "2026-08-08");
  assert.equal(dayKey(instant, "America/New_York"), "2026-08-07");
  assert.equal(dayKey(instant, "UTC"), "2026-08-07");
});

test("dayKey refuses a millisecond clock", () => {
  // Date.now() here would silently bucket everything into the year 57000.
  assert.throws(() => dayKey(Date.UTC(2026, 7, 7)), /milliseconds/);
  assert.throws(() => dayKey(Number.NaN), /unix seconds/);
});

test("previousDayKey rolls months, years and leap days", () => {
  assert.equal(previousDayKey("2026-08-08"), "2026-08-07");
  assert.equal(previousDayKey("2026-08-01"), "2026-07-31");
  assert.equal(previousDayKey("2026-01-01"), "2025-12-31");
  assert.equal(previousDayKey("2026-03-01"), "2026-02-28");
  assert.equal(previousDayKey("2024-03-01"), "2024-02-29");
});

test("previousDayKey rejects anything that is not a day key", () => {
  for (const bad of ["", "2026-8-8", "20260808", "2026-08-08T00:00:00Z", "yesterday"]) {
    assert.throws(() => previousDayKey(bad), `expected throw: ${JSON.stringify(bad)}`);
  }
});

test("relativeDayLabel names only today and yesterday", () => {
  const now = seconds(2026, 8, 8, 4, 0, 0); // noon SGT on the 8th
  assert.equal(relativeDayLabel("2026-08-08", now), "Today");
  assert.equal(relativeDayLabel("2026-08-07", now), "Yesterday");
  assert.equal(relativeDayLabel("2026-08-06", now), null);
  assert.equal(relativeDayLabel("2026-08-09", now), null);
});

test("relativeDayLabel survives a DST shift in the zone it is given", () => {
  // 00:30 EDT on the morning after US clocks sprang forward. Deriving yesterday
  // by subtracting 86400 seconds lands on 2026-03-07 and mislabels both days;
  // calendar arithmetic on the day key does not.
  const now = seconds(2026, 3, 9, 4, 30, 0);
  assert.equal(dayKey(now, "America/New_York"), "2026-03-09");
  assert.equal(relativeDayLabel("2026-03-08", now, "America/New_York"), "Yesterday");
  assert.equal(relativeDayLabel("2026-03-07", now, "America/New_York"), null);
});

const row = (id: number, blockTime: number) => ({ id, blockTime });

test("groupByDay keeps the caller's order, newest-first in and out", () => {
  const rows = [
    row(1, seconds(2026, 8, 8, 6, 0, 0)),
    row(2, seconds(2026, 8, 8, 2, 0, 0)),
    row(3, seconds(2026, 8, 7, 10, 0, 0)),
  ];
  assert.deepEqual(
    groupByDay(rows, (r) => r.blockTime).map((group) => [group.day, group.rows.map((r) => r.id)]),
    [
      ["2026-08-08", [1, 2]],
      ["2026-08-07", [3]],
    ],
  );
});

test("non-adjacent rows for one day land in one group", () => {
  // A page that arrived out of order must not render two "Today" headers.
  const rows = [
    row(1, seconds(2026, 8, 8, 6, 0, 0)),
    row(2, seconds(2026, 8, 7, 10, 0, 0)),
    row(3, seconds(2026, 8, 8, 2, 0, 0)),
  ];
  assert.deepEqual(
    groupByDay(rows, (r) => r.blockTime).map((group) => [group.day, group.rows.map((r) => r.id)]),
    [
      ["2026-08-08", [1, 3]],
      ["2026-08-07", [2]],
    ],
  );
});

test("groupByDay on an empty feed is an empty list, not a phantom day", () => {
  assert.deepEqual(groupByDay([], (r: { blockTime: number }) => r.blockTime), []);
});

test("a rolling window walks back the given number of days", () => {
  assert.equal(minusDaysKey("2026-08-10", 0), "2026-08-10");
  assert.equal(minusDaysKey("2026-08-10", 1), "2026-08-09");
  // The 7-day window the merchant Overview uses is today plus the six before it.
  assert.equal(minusDaysKey("2026-08-10", 6), "2026-08-04");
});

test("a rolling window crosses month, year and leap-day boundaries", () => {
  assert.equal(minusDaysKey("2026-03-01", 6), "2026-02-23");
  assert.equal(minusDaysKey("2027-01-02", 6), "2026-12-27");
  assert.equal(minusDaysKey("2028-03-01", 6), "2028-02-24"); // through 29 Feb
});

test("minusDaysKey refuses a malformed key or a nonsense count", () => {
  assert.throws(() => minusDaysKey("2026-8-10", 6), /invalid day key/);
  assert.throws(() => minusDaysKey("2026-08-10", -1), /non-negative integer/);
  assert.throws(() => minusDaysKey("2026-08-10", 1.5), /non-negative integer/);
});

test("a day key renders as its own date in the display zone", () => {
  // Midnight UTC would be 08:00 SGT the same day but the PREVIOUS day in New
  // York, which is the bug this helper exists to avoid.
  const format = (day: string, timeZone: string): string =>
    new Intl.DateTimeFormat("en-SG", { timeZone, day: "numeric", month: "short" }).format(
      dayKeyMiddayUnixSeconds(day) * 1000,
    );
  assert.equal(format("2026-08-10", DISPLAY_TIME_ZONE), "10 Aug");
  assert.equal(format("2026-08-10", "America/New_York"), "10 Aug");
  assert.equal(format("2026-08-10", "UTC"), "10 Aug");
});
