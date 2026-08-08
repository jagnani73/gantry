"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SettlementCursor, SettlementEvent } from "@gantry/shared";
import { api, ApiClientError } from "@/lib/api";
import { backendUrl } from "@/lib/env";

/**
 * One merchant's settlement history, merged with the live stream.
 *
 * Two sources describe the same table: `GET /api/settlements` pages backwards
 * through it and the SSE stream pushes the head of it. They overlap — the stream
 * replays its most recent rows on every connect — so the merge dedupes on
 * `(txHash, logIndex)`, which is the backend's own primary key and the grammar
 * of both the SSE event id and a page cursor. Deduping on anything else (a tx
 * hash alone, an intent id) would collapse two settlements that shared a
 * transaction, which the contract permits.
 *
 * Rows are held in a Map and sorted on read rather than appended in arrival
 * order, because arrival order is not chronological: a replay burst can land
 * after the first history page, and a history page always lands after whatever
 * the stream pushed while it was in flight.
 */

const PAGE_SIZE = 50;

/** The replay burst on connect is history, not news. Rows inside this window of
 * a fresh connection must not tint or ring — a dashboard opened at 4pm would
 * otherwise chime for every payment taken since lunch. */
const REPLAY_GRACE_MS = 2_000;

/** How long a row keeps its one-shot arrival tint. Cleared afterwards so that
 * navigating away and back does not replay the highlight on stale rows. */
const FRESH_MS = 2_000;

export function settlementKey(row: SettlementEvent): string {
  return `${row.txHash}:${row.logIndex}`;
}

/**
 * `live` and `connecting` are not the same claim. Browsers auto-retry a dropped
 * network but close an EventSource permanently on a non-200 or a CORS failure —
 * showing "reconnecting…" for the second case is a lie that eats setup time on
 * stage, so a CLOSED stream says so.
 */
export type FeedConnection = "connecting" | "live" | "disconnected";

export type HistoryStatus = "loading" | "ready" | "error";

export interface MerchantFeed {
  /** Newest first, by (blockNumber, logIndex). */
  rows: readonly SettlementEvent[];
  connection: FeedConnection;
  /** True while a row is still wearing its arrival highlight. */
  isFresh(row: SettlementEvent): boolean;
  historyStatus: HistoryStatus;
  historyError: string | null;
  /** Rows this merchant has on the server, ignoring pagination. */
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  /** Drop everything and re-read both sources. The feed's only recovery path. */
  retry(): void;
}

function newestFirst(a: SettlementEvent, b: SettlementEvent): number {
  return b.blockNumber - a.blockNumber || b.logIndex - a.logIndex;
}

function describe(err: unknown): string {
  return err instanceof ApiClientError || err instanceof Error ? err.message : String(err);
}

export function useMerchantFeed(
  handle: string,
  onLive: (row: SettlementEvent) => void,
): MerchantFeed {
  const [byKey, setByKey] = useState<ReadonlyMap<string, SettlementEvent>>(() => new Map());
  const [connection, setConnection] = useState<FeedConnection>("connecting");
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("loading");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [serverTotal, setServerTotal] = useState(0);
  const [cursor, setCursor] = useState<SettlementCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [epoch, setEpoch] = useState(0);

  // Dedupe lives in a ref, not in the Map, because the chime decision has to be
  // made synchronously inside the event handler — a `setState` updater runs too
  // late to answer "have I already seen this row?".
  const seen = useRef(new Set<string>());
  const fresh = useRef(new Set<string>());
  const [freshTick, setFreshTick] = useState(0);
  // The epoch a request was issued under. A page that resolves after a retry
  // belongs to a feed that no longer exists and must not be merged back in.
  const epochRef = useRef(epoch);
  epochRef.current = epoch;

  const onLiveRef = useRef(onLive);
  useEffect(() => {
    onLiveRef.current = onLive;
  }, [onLive]);

  const merge = useCallback((incoming: readonly SettlementEvent[]) => {
    const added = incoming.filter((row) => {
      const key = settlementKey(row);
      if (seen.current.has(key)) return false;
      seen.current.add(key);
      return true;
    });
    if (added.length === 0) return;
    setByKey((prev) => {
      const next = new Map(prev);
      for (const row of added) next.set(settlementKey(row), row);
      return next;
    });
  }, []);

  const retry = useCallback(() => {
    seen.current.clear();
    fresh.current.clear();
    setByKey(new Map());
    setCursor(null);
    setServerTotal(0);
    setHistoryError(null);
    setEpoch((previous) => previous + 1);
  }, []);

  useEffect(() => {
    const source = new EventSource(`${backendUrl()}/api/events`);
    let openedAt = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];
    setConnection("connecting");

    source.onopen = () => {
      openedAt = Date.now();
      setConnection("live");
    };
    source.onerror = () => {
      setConnection(source.readyState === EventSource.CLOSED ? "disconnected" : "connecting");
    };

    source.addEventListener("settlement", (event) => {
      const row = JSON.parse(event.data) as SettlementEvent;
      // The stream carries every merchant on the rail; this surface is one shop.
      if (row.handle !== handle) return;
      const key = settlementKey(row);
      if (seen.current.has(key)) return;
      seen.current.add(key);

      const live = Date.now() - openedAt > REPLAY_GRACE_MS;
      if (live) {
        fresh.current.add(key);
        setFreshTick((tick) => tick + 1);
        timers.push(
          setTimeout(() => {
            fresh.current.delete(key);
            setFreshTick((tick) => tick + 1);
          }, FRESH_MS),
        );
      }
      setByKey((prev) => new Map(prev).set(key, row));
      if (live) onLiveRef.current(row);
    });

    // `demo-reset` clears the cache and bumps an epoch server-side; the feed has
    // to forget the rows it is holding or a rehearsal starts with the last one.
    source.addEventListener("reset", () => retry());

    return () => {
      for (const timer of timers) clearTimeout(timer);
      source.close();
    };
  }, [handle, epoch, retry]);

  useEffect(() => {
    const issuedAt = epoch;
    let cancelled = false;
    setHistoryStatus("loading");
    api
      .settlements({ handle, limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled || epochRef.current !== issuedAt) return;
        merge(page.rows);
        setServerTotal(page.total);
        setCursor(page.nextCursor);
        setHistoryStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled || epochRef.current !== issuedAt) return;
        setHistoryError(describe(err));
        setHistoryStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [handle, epoch, merge]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    const issuedAt = epochRef.current;
    setLoadingMore(true);
    api
      .settlements({ handle, before: cursor, limit: PAGE_SIZE })
      .then((page) => {
        if (epochRef.current !== issuedAt) return;
        merge(page.rows);
        setServerTotal(page.total);
        setCursor(page.nextCursor);
        setHistoryError(null);
      })
      .catch((err: unknown) => {
        if (epochRef.current === issuedAt) setHistoryError(describe(err));
      })
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, handle, merge]);

  const rows = useMemo(() => [...byKey.values()].sort(newestFirst), [byKey]);

  const isFresh = useCallback(
    (row: SettlementEvent) => {
      void freshTick; // re-read the ref whenever a row enters or leaves the set
      return fresh.current.has(settlementKey(row));
    },
    [freshTick],
  );

  return {
    rows,
    connection,
    isFresh,
    historyStatus,
    historyError,
    // Once the last page is in, the loaded rows ARE the whole table, so counting
    // them keeps the nav badge correct as payments land. While pages remain, the
    // server's unpaginated count is the only number that is not a lower bound.
    total: cursor === null ? rows.length : serverTotal,
    hasMore: cursor !== null,
    loadingMore,
    loadMore,
    retry,
  };
}
