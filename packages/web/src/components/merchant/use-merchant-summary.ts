"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CARD_FEE_BPS,
  decodeCursor,
  isAfterCursor,
  isInMonth,
  monthKey,
  monthStartUnixSeconds,
  type SettlementEvent,
  type SettlementSummaryResponse,
} from "@gantry/shared";
import { api } from "@/lib/api";
import { totalsOf, type FeedTotals } from "./format";

/**
 * The merchant Overview's KPI figures: this calendar month, summed on the
 * server, kept current from the live feed.
 *
 * The shape is the point. The tiles used to sum `feed.rows` — whatever this
 * browser had paged in — under a heading that named a span of TIME, so a page
 * size and a window were describing the same numbers and only agreed while a
 * shop's takings happened to fit in one page. Widening the page made that worse,
 * not better. So the total now comes from SQL over the whole book and the feed's
 * page size cannot move it.
 *
 * The live half is DERIVED, never accumulated, and that is what makes it safe.
 * A running counter incremented per arriving row would double-count on every
 * reconnect, because the SSE stream replays its recent rows on connect. Instead
 * this recomputes each render over `feed.rows` — a Map keyed on `(txHash,
 * logIndex)`, so the same row delivered twice is one row — keeping only what the
 * snapshot did not already contain. Fold the same row in a hundred times and the
 * arithmetic is unchanged.
 *
 * "Did not already contain" is a POSITION comparison against the mark the server
 * reported, not a timestamp one. `latest` is the newest row the server saw for
 * this filter even when the month's window is empty, so a shop that has not
 * traded yet this month still has a floor to compare against.
 */

export type SummaryStatus = "loading" | "ready" | "error";

export interface MerchantSummary {
  status: SummaryStatus;
  error: string | null;
  /** The month these figures cover, as a `YYYY-MM` key — what the header names
   * and what a stale tab is checked against. */
  month: string;
  /** Server totals plus anything the live feed has seen since. */
  totals: FeedTotals;
  /** How many of `totals` arrived live rather than in the server's sum. Not for
   * display: it is what lets a screen tell "the server said zero" apart from
   * "nothing has happened", which are different sentences. */
  liveCount: number;
  retry(): void;
}

const EMPTY: FeedTotals = {
  count: 0,
  gross: 0n,
  fees: 0n,
  net: 0n,
  saved: 0n,
  agentCount: 0,
};

/**
 * Server sum + live delta, combined the way `totalsOf` combines rows.
 *
 * `saved` is recomputed from the combined gross rather than added, because it is
 * a benchmark against a rate and not a quantity: summing two independently
 * clamped `saved` figures would drift from what the same rate says about the
 * total. Same reason `net` is derived rather than carried.
 */
function combine(snapshot: SettlementSummaryResponse | null, live: FeedTotals): FeedTotals {
  if (!snapshot) return live;
  const gross = BigInt(snapshot.gross) + live.gross;
  const fees = BigInt(snapshot.fees) + live.fees;
  const cardFees = (gross * BigInt(CARD_FEE_BPS)) / 10_000n;
  const saved = cardFees - fees;
  return {
    count: snapshot.count + live.count,
    gross,
    fees,
    net: gross - fees,
    saved: saved < 0n ? 0n : saved,
    agentCount: snapshot.agentCount + live.agentCount,
  };
}

export function useMerchantSummary(
  handle: string,
  rows: readonly SettlementEvent[],
  nowSeconds: number | null,
): MerchantSummary {
  const [snapshot, setSnapshot] = useState<SettlementSummaryResponse | null>(null);
  const [status, setStatus] = useState<SummaryStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The month, not the clock. `nowSeconds` ticks every second, and everything
  // downstream of it is derived from this key instead so that a tick produces no
  // new values: refetching per second would be a request per second per open
  // tab, and a `totals` object rebuilt per second would change the shell's
  // context value under all five merchant screens for no new information. The
  // key changes once a month — exactly when the `since` bound below goes stale
  // under a tab someone left open overnight.
  const month = nowSeconds === null ? null : monthKey(nowSeconds);
  const monthStart = month === null ? null : `${month}-01`;
  const since = useMemo(
    () => (nowSeconds === null ? null : monthStartUnixSeconds(nowSeconds)),
    // Intentionally keyed on the month, not on `nowSeconds` — every instant
    // inside one month yields the same bound, so recomputing it per tick is
    // wasted Intl work. eslint cannot see that `month` determines it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [month],
  );

  useEffect(() => {
    if (since === null) return;
    let cancelled = false;
    setStatus("loading");
    setError(null);
    api
      .settlementSummary({ handle, since })
      .then((value) => {
        if (cancelled) return;
        setSnapshot(value);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The snapshot is deliberately NOT cleared. A failed refetch after a
        // month rollover would otherwise blank a figure that was correct a
        // second ago; the error is surfaced beside it instead, and the caller
        // decides whether a stale total is worth showing. What it must never do
        // is render a confident S$0.00 built from nothing.
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // `month` is in the deps so a rollover refetches; `since` is derived from it
    // and would be enough on its own, but naming both keeps the intent readable.
  }, [handle, month, since, attempt]);

  const live = useMemo(() => {
    if (!snapshot || monthStart === null) return EMPTY;
    const mark = snapshot.latest === null ? null : decodeCursor(snapshot.latest);
    const fresh = rows.filter((row) => {
      // No mark means this filter had never matched anything when the snapshot
      // was taken, so every row the feed holds is news.
      if (mark && !isAfterCursor({ blockNumber: row.blockNumber, logIndex: row.logIndex }, mark)) {
        return false;
      }
      return isInMonth(row.blockTime, monthStart);
    });
    return totalsOf(fresh, CARD_FEE_BPS);
  }, [rows, snapshot, monthStart]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);

  return useMemo(
    () => ({
      status,
      error,
      month: month ?? "",
      totals: combine(snapshot, live),
      liveCount: live.count,
      retry,
    }),
    [status, error, month, snapshot, live, retry],
  );
}
