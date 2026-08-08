import { test } from "node:test";
import assert from "node:assert/strict";
import { DISPLAY_TIME_ZONE, dayKey, groupByDay, previousDayKey, relativeDayLabel } from "./days";

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
