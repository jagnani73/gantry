"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CARD_FEE_BPS,
  decodeCursor,
  isAfterCursor,
  type SettlementEvent,
  type SettlementSummaryResponse,
} from "@gantry/shared";
import { api } from "@/lib/api";
import { totalsOf, type FeedTotals } from "./format";

/**
 * Settlement totals from `since`, summed on the server, kept current from the
 * live feed.
 *
 * The shape is the point. These figures used to sum `feed.rows` — whatever the
 * browser had paged in — under headings that named a span of TIME or "to date",
 * so a page size was silently deciding a merchant's takings and only agreed with
 * the label while a shop's book happened to fit in one page. Widening the page
 * made that worse, not better. The total now comes from SQL over the whole book,
 * and the feed's page size cannot move it.
 *
 * `since` is the caller's, which is what lets ONE hook serve both merchant
 * questions: Overview passes the month boundary, Payouts passes 0 for lifetime.
 * They differ in a number and in nothing else — no second endpoint, no second
 * fold, no second place for the two to drift apart.
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
 * this filter even when the window is empty, so a shop that has not traded since
 * `since` still has a floor to compare against.
 */

export type SummaryStatus = "loading" | "ready" | "error";

export interface MerchantSummary {
  status: SummaryStatus;
  error: string | null;
  /** Server totals plus anything the live feed has seen since. */
  totals: FeedTotals;
  retry(): void;
}

/** Lifetime: every settlement this merchant has ever taken. Named rather than
 * written as a bare `0` at the call site, because `0` there reads like a
 * placeholder for a bound nobody got round to computing. */
export const SINCE_ALL_TIME = 0;

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
  since: number | null,
): MerchantSummary {
  const [snapshot, setSnapshot] = useState<SettlementSummaryResponse | null>(null);
  const [status, setStatus] = useState<SummaryStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

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
    // `since` is a number, so a caller recomputing it from a per-second clock
    // still compares equal and does not refire this. It changes when the window
    // does — at a month rollover under a tab left open overnight.
  }, [handle, since, attempt]);

  const live = useMemo(() => {
    if (!snapshot || since === null) return EMPTY;
    const mark = snapshot.latest === null ? null : decodeCursor(snapshot.latest);
    const fresh = rows.filter((row) => {
      // No mark means this filter had never matched anything when the snapshot
      // was taken, so every row the feed holds is news.
      if (mark && !isAfterCursor({ blockNumber: row.blockNumber, logIndex: row.logIndex }, mark)) {
        return false;
      }
      // The SAME bound the server summed from, rather than a second expression
      // of the same window. A DayKey comparison alongside a unix-second one
      // would be two things to keep in step across midnight on the 1st, where
      // disagreeing by a second counts a payment twice or not at all.
      //
      // No upper bound, deliberately. `since` comes from a periodic tick, so for
      // a moment after a rollover it is behind the chain BY CONSTRUCTION; a
      // closed top would drop the newest payment at exactly the moment a
      // merchant is watching it land, and nothing arrives from the future.
      return row.blockTime >= since;
    });
    return totalsOf(fresh, CARD_FEE_BPS);
  }, [rows, snapshot, since]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);

  return useMemo(
    () => ({ status, error, totals: combine(snapshot, live), retry }),
    [status, error, snapshot, live, retry],
  );
}
