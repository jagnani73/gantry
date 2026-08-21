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
 * There is deliberately NO `isInMonth(row, month)` predicate here.
 *
 * There was one, and it was a second expression of a boundary
 * `monthStartUnixSeconds` already defines — a DayKey comparison in the browser
 * beside a `block_time >= ?` in SQLite, two things to keep in step across
 * midnight on the 1st, where disagreeing by one second counts a payment twice or
 * not at all. Clients filter live rows on `blockTime >= monthStartUnixSeconds()`
 * instead: the same number the server summed from, so the two cannot drift.
 *
 * Keep the comparison OPEN at the top end wherever it is written. The bound
 * comes from a periodic clock tick, so just after a rollover it is behind the
 * chain BY CONSTRUCTION; a closed top would drop the newest payment at exactly
 * the moment a merchant is watching it land, and nothing arrives from the
 * future.
 */
