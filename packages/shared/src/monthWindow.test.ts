import { test } from "node:test";
import assert from "node:assert/strict";
import { isInMonth, monthKey, monthStartDayKey, monthStartUnixSeconds } from "./monthWindow";

/** Unix seconds for an SGT wall-clock instant (SGT is UTC+8, no DST). */
const sgt = (...parts: [number, number, number, number?, number?]): number =>
  Date.UTC(parts[0], parts[1] - 1, parts[2], (parts[3] ?? 12) - 8, parts[4] ?? 0) / 1000;

test("the window opens on the 1st, wherever in the month the clock is", () => {
  assert.equal(monthStartDayKey(sgt(2026, 8, 21)), "2026-08-01");
  assert.equal(monthStartDayKey(sgt(2026, 8, 1)), "2026-08-01");
  assert.equal(monthStartDayKey(sgt(2026, 8, 31, 23, 59)), "2026-08-01");
});

test("the month is bucketed in SGT, not the host's zone", () => {
  // 15:59Z is 23:59 SGT on 31 July; 16:00Z is 00:00 SGT on 1 August. A UTC
  // backend and an SGT browser must not disagree about which month a payment
  // was taken in — the whole point of pinning the zone.
  assert.equal(monthStartDayKey(Date.UTC(2026, 6, 31, 15, 59) / 1000), "2026-07-01");
  assert.equal(monthStartDayKey(Date.UTC(2026, 6, 31, 16, 0) / 1000), "2026-08-01");
});

test("the since bound is SGT midnight, which is 16:00Z the day before", () => {
  // The bound the server sums from. An hour out either way silently moves a
  // whole evening's takings between months, and every figure on the screen
  // still agrees with every other one.
  assert.equal(monthStartUnixSeconds(sgt(2026, 8, 21)), Date.UTC(2026, 6, 31, 16, 0) / 1000);
  assert.equal(monthStartUnixSeconds(sgt(2026, 1, 15)), Date.UTC(2025, 11, 31, 16, 0) / 1000);
});

test("the bound is the first instant inside the month, not the last outside it", () => {
  const start = monthStartDayKey(sgt(2026, 8, 21));
  const since = monthStartUnixSeconds(sgt(2026, 8, 21));
  // A payment at 00:00:00 SGT on the 1st is IN. A `>` bound rather than `>=`
  // would drop it, and nothing on the screen would say so.
  assert.equal(since, sgt(2026, 8, 1, 0, 0));
  assert.equal(isInMonth(since, start), true);
  assert.equal(isInMonth(since - 1, start), false);
});

test("the client-side predicate agrees with the server's `since` bound", () => {
  // Two different expressions of one boundary — the browser filters live rows on
  // a DayKey while SQLite filters on `block_time >= ?`. They must not disagree
  // about the seconds either side of midnight on the 1st, or a payment taken at
  // 00:00:30 counts twice (in the sum AND as a live row) or not at all.
  const now = sgt(2026, 8, 21);
  const start = monthStartDayKey(now);
  const since = monthStartUnixSeconds(now);
  for (const offset of [-2, -1, 0, 1, 2, 3600, 86_400]) {
    assert.equal(
      isInMonth(since + offset, start),
      since + offset >= since,
      `disagreed at since${offset >= 0 ? "+" : ""}${offset}`,
    );
  }
});

test("a row dated ahead of the boundary is kept, not dropped", () => {
  // The tick supplying the boundary is periodic, so just after midnight on the
  // 1st it is briefly behind the chain. Dropping the newest row is the worst
  // thing this view can do — see the note on isInMonth.
  const stale = monthStartDayKey(sgt(2026, 7, 31, 23, 59));
  assert.equal(isInMonth(sgt(2026, 8, 1, 0, 1), stale), true);
});

test("monthKey changes exactly at the boundary", () => {
  assert.equal(monthKey(sgt(2026, 8, 31, 23, 59)), "2026-08");
  assert.equal(monthKey(sgt(2026, 9, 1, 0, 1)), "2026-09");
});
