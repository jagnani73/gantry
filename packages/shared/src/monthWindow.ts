import { dayKey, dayKeyStartUnixSeconds, type DayKey } from "./days";

/**
 * The merchant Overview's window: the calendar month, in the merchant's own
 * zone.
 *
 * This replaced a rolling seven-day window, and the reason is worth keeping
 * because it is not the reason the rolling window was chosen against. The old
 * window was fine arithmetic sitting on the wrong data: the tiles summed the
 * rows this browser had PAGED IN, so a label describing a span of TIME was
 * really describing a COUNT, and the two only agreed while a shop's week fitted
 * inside one page. Widening the page made that worse rather than better. The
 * tiles now read a server-side sum over the whole book
 * (`SettlementSummaryResponse`), so the window is free to be whatever a merchant
 * actually reconciles against — and that is a calendar month, not a rolling one.
 *
 * The known cost, argued the other way when the rolling window was written: a
 * calendar window empties itself at its own boundary, so at 09:00 on the 1st
 * these tiles read S$0.00 over a shop that traded all month. The objection was
 * never the zero — that zero is TRUE — it was that a merchant cannot tell it
 * apart from a broken dashboard. So the empty state names the boundary
 * ("Nothing settled since 1 September") instead of saying "no payments", which
 * is the part that carried the ambiguity.
 *
 * It lives in `shared` for the reason the rolling window did: `packages/web` has
 * no test suite, and every expression here fails SILENTLY AND SELF-CONSISTENTLY.
 * Move the boundary and the header, the tiles and the empty state all shift
 * together, each corroborating the others — a merchant cannot detect that, and
 * neither can a presenter mid-demo.
 */

/**
 * The first day of the month an instant falls in.
 *
 * Sliced off the DayKey rather than computed through a `Date`, because the key
 * is already bucketed into `DISPLAY_TIME_ZONE` and `YYYY-MM` is a prefix of it.
 * Going back through a Date would reintroduce exactly the zone question
 * `dayKey` exists to have already answered.
 */
export function monthStartDayKey(nowSeconds: number): DayKey {
  return `${dayKey(nowSeconds).slice(0, 7)}-01`;
}

/**
 * The instant the current month begins — the `since` bound the server sums from.
 *
 * The browser computes this, not the backend, and that is deliberate: the window
 * is a product decision that belongs beside the label naming it, and the summary
 * endpoint stays a general "sum from here" that the payer surfaces could reuse
 * with a different edge.
 */
export function monthStartUnixSeconds(nowSeconds: number): number {
  return dayKeyStartUnixSeconds(monthStartDayKey(nowSeconds));
}

/**
 * Identifies the month itself (`"2026-08"`) — what a client watches to notice
 * the boundary pass under it, so a tab left open overnight on the 31st refetches
 * instead of showing last month's total under this month's heading.
 */
export function monthKey(nowSeconds: number): string {
  return dayKey(nowSeconds).slice(0, 7);
}

/**
 * Is this row inside the month opening on `monthStart`?
 *
 * Takes the BOUNDARY rather than a `now`, which is a performance decision as
 * much as a correctness one: the caller's clock ticks every second, and a
 * predicate reading it would make every derived total a fresh object once a
 * second — on the merchant surface that is a context value changing under five
 * screens for no new information. The boundary changes once a month.
 *
 * Deliberately OPEN at the top end, inherited from the rolling window this
 * replaced for a reason that still applies: the boundary comes from a periodic
 * tick, so for a moment either side of midnight on the 1st it is behind the
 * chain BY CONSTRUCTION. An upper bound would drop the newest payment off the
 * screen at exactly the moment a merchant is watching it land, and nothing can
 * legitimately arrive from the future, so it buys nothing and costs that.
 */
export function isInMonth(atSeconds: number, monthStart: DayKey): boolean {
  // Lexical order is chronological order for `YYYY-MM-DD`; see the DayKey type.
  return dayKey(atSeconds) >= monthStart;
}
