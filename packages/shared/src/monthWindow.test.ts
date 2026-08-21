import { test } from "node:test";
import assert from "node:assert/strict";
import { monthStartDayKey, monthStartUnixSeconds } from "./monthWindow";

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
  // A payment at 00:00:00 SGT on the 1st is IN, on both sides: SQLite filters
  // `block_time >= since` and the browser filters `blockTime >= since` on this
  // very number. An exclusive bound would drop the first payment of every month
  // from both, and nothing on the screen would say so.
  const since = monthStartUnixSeconds(sgt(2026, 8, 21));
  assert.equal(since, sgt(2026, 8, 1, 0, 0));
  assert.equal(sgt(2026, 8, 1, 0, 0) >= since, true);
  assert.equal(sgt(2026, 7, 31, 23, 59) >= since, false);
});

test("the bound is stable everywhere inside one month", () => {
  // What lets a caller recompute it from a per-second clock without refetching:
  // every instant in the month yields the same number, so it compares equal in a
  // dependency array. It must change at the boundary and nowhere else.
  const august = monthStartUnixSeconds(sgt(2026, 8, 1, 0, 0));
  assert.equal(monthStartUnixSeconds(sgt(2026, 8, 21, 14, 30)), august);
  assert.equal(monthStartUnixSeconds(sgt(2026, 8, 31, 23, 59)), august);
  assert.notEqual(monthStartUnixSeconds(sgt(2026, 9, 1, 0, 1)), august);
});
