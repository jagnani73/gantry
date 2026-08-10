import { dayKey, minusDaysKey, type DayKey } from "./days";

/**
 * The merchant Overview's rolling window: which rows the KPI tiles count, and
 * whether the figures they produce are a total or a floor.
 *
 * This lives in `shared` rather than beside the screen because `packages/web`
 * has no test suite, and the two expressions below fail SILENTLY AND
 * SELF-CONSISTENTLY. Flip the `- 1` or the `>=` and there is no compile error,
 * no visible break, and the Overview header still agrees with the tiles —
 * because the header is derived from `overviewWindowStart` too. "4–10 August ·
 * S$400.98" simply becomes "3–10 August · S$412.40", every part of the screen
 * corroborating the wrong number. A merchant cannot detect that, and neither
 * can a presenter mid-demo. Same reason `dashboardScope.ts` and
 * `agentStatus.ts` live here.
 */

/**
 * How many days the tiles cover, today included.
 *
 * A ROLLING window, not a calendar one, and that is the whole point. Takings
 * are lumpy enough that a single day was too short a bucket — one quiet Tuesday
 * reads as a broken dashboard — but a calendar week empties itself at its own
 * boundary: on a Monday morning "collected this week" shows zero though the
 * shop traded all weekend, and a merchant cannot tell that from a dead feed. A
 * rolling window never has that cliff.
 */
export const OVERVIEW_WINDOW_DAYS = 7;

/**
 * The first day the tiles count, in the merchant's own zone.
 *
 * `- 1` because the window is inclusive of today: seven days is today plus the
 * six before it. Pinned by `overviewWindow.test.ts` precisely because that
 * looks like an off-by-one to a reader who has not counted.
 */
export function overviewWindowStart(nowSeconds: number): DayKey {
  return minusDaysKey(dayKey(nowSeconds), OVERVIEW_WINDOW_DAYS - 1);
}

/**
 * The rows inside the window, in the merchant's own zone.
 *
 * `dayKey` pins both sides of the comparison to SGT, so a UTC backend and an
 * SGT browser cannot disagree about which side of midnight a payment fell on.
 * (`minusDaysKey` pins nothing — it is pure calendar arithmetic on an already
 * zoned key.)
 *
 * Deliberately OPEN at the top end: a row counts if it is on or after the start
 * day, with no upper bound. This is not only a defence against a mis-set clock.
 * The caller's `now` is a periodic tick, so around midnight the window start is
 * briefly a day behind the chain BY CONSTRUCTION, and an upper bound would then
 * drop the newest row off the screen — the single most alarming thing this view
 * can do. Nothing can legitimately arrive from the future, so the bound buys
 * nothing and costs that.
 */
export function rowsInOverviewWindow<T>(
  rows: readonly T[],
  at: (row: T) => number,
  nowSeconds: number,
): readonly T[] {
  const start = overviewWindowStart(nowSeconds);
  // Lexical order is chronological order for `YYYY-MM-DD`, which is why a
  // DayKey is a string; see the note on the type.
  return rows.filter((row) => dayKey(at(row)) >= start);
}

/**
 * Whether the window's figures are a floor rather than a total.
 *
 * The feed pages backwards from the newest row, so the window's rows are a
 * prefix of what is loaded: the moment one loaded row predates the start day,
 * the window is complete and the KPIs are exact no matter how many older pages
 * remain. Only when EVERY loaded row falls inside the window can an unloaded
 * page still hold more of it — and then the takings, the payment count and the
 * card comparison are all lower bounds, which a merchant cannot possibly infer
 * from the screen.
 *
 * The predicate is `windowCount === loadedCount`, which is order-INDEPENDENT
 * and therefore stronger than the prefix argument above needs. That is
 * deliberate: if paging ever stopped being contiguous, an order-dependent test
 * would go quiet and the tiles would under-report a merchant's takings with no
 * warning, which is the exact failure this function exists to prevent.
 *
 * `loadedCount > 0` is load-bearing. Without it a feed that has loaded nothing
 * while `hasMore` is true — first paint, and the moment after the `reset` event
 * `demo-reset` fires — satisfies `0 === 0`, and the screen renders "no payments
 * in the last 7 days" directly above "covers the 0 payments loaded so far".
 */
export function windowIsPartial(
  windowCount: number,
  loadedCount: number,
  hasMore: boolean,
): boolean {
  return hasMore && loadedCount > 0 && windowCount === loadedCount;
}
