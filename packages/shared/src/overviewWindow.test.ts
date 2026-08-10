import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OVERVIEW_WINDOW_DAYS,
  overviewWindowStart,
  rowsInOverviewWindow,
  windowIsPartial,
} from "./overviewWindow";

/** Unix seconds for an SGT wall-clock instant (SGT is UTC+8, no DST). */
const sgt = (...parts: [number, number, number, number?, number?]): number =>
  Date.UTC(parts[0], parts[1] - 1, parts[2], (parts[3] ?? 12) - 8, parts[4] ?? 0) / 1000;

const at = (row: { blockTime: number }): number => row.blockTime;

test("the window is inclusive of today, so seven days reaches back six", () => {
  // The assertion the `- 1` exists for. Off by one either way and every figure
  // on the screen still agrees with the header, so nothing else catches it.
  assert.equal(OVERVIEW_WINDOW_DAYS, 7);
  assert.equal(overviewWindowStart(sgt(2026, 8, 10)), "2026-08-04");
});

test("the window start rolls with the clock, not with the calendar", () => {
  // A rolling window has no weekday boundary: consecutive days give consecutive
  // starts, where a calendar week would repeat one start for seven days.
  assert.equal(overviewWindowStart(sgt(2026, 8, 11)), "2026-08-05");
  assert.equal(overviewWindowStart(sgt(2026, 8, 12)), "2026-08-06");
  // ...and it crosses a month boundary without special-casing.
  assert.equal(overviewWindowStart(sgt(2026, 3, 2)), "2026-02-24");
});

test("the window start is bucketed in SGT, not the host's zone", () => {
  // 15:59Z is 23:59 SGT on the 10th; 16:00Z is 00:00 SGT on the 11th. A UTC host
  // and an SGT browser must not disagree about which window a payment falls in.
  assert.equal(overviewWindowStart(Date.UTC(2026, 7, 10, 15, 59) / 1000), "2026-08-04");
  assert.equal(overviewWindowStart(Date.UTC(2026, 7, 10, 16, 0) / 1000), "2026-08-05");
});

test("the start day is inside the window and the day before it is not", () => {
  const now = sgt(2026, 8, 10);
  const rows = [
    { blockTime: sgt(2026, 8, 10, 9), tag: "today" },
    { blockTime: sgt(2026, 8, 4, 0, 30), tag: "start day, just after midnight" },
    { blockTime: sgt(2026, 8, 3, 23, 30), tag: "just before the window opens" },
  ];
  assert.deepEqual(
    rowsInOverviewWindow(rows, at, now).map((row) => row.tag),
    ["today", "start day, just after midnight"],
  );
});

test("a row dated ahead of the clock is kept, not dropped", () => {
  // The tick that supplies `now` is periodic, so around midnight the window
  // start is briefly a day behind the chain. Dropping the newest row would be
  // the worst thing this view could do.
  const now = sgt(2026, 8, 10, 23, 59);
  const rows = [{ blockTime: sgt(2026, 8, 11, 0, 1), tag: "just past midnight" }];
  assert.equal(rowsInOverviewWindow(rows, at, now).length, 1);
});

test("an empty feed is never partial, however many pages remain", () => {
  // Without the loadedCount guard this returns true, and the screen renders
  // "no payments in the last 7 days" above "covers the 0 payments loaded so
  // far" — on first paint and right after demo-reset's reset event.
  assert.equal(windowIsPartial(0, 0, true), false);
});

test("figures are a floor only when every loaded row is inside the window", () => {
  assert.equal(windowIsPartial(50, 50, true), true); // a full page, all in window
  assert.equal(windowIsPartial(12, 50, true), false); // a loaded row predates the window
  assert.equal(windowIsPartial(50, 50, false), false); // nothing left to load
});
