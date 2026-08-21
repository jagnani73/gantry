"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { monthStartUnixSeconds, type MerchantResponse, type SettlementEvent } from "@gantry/shared";
import { api, ApiClientError } from "@/lib/api";
import { useChime, type ChimeControl } from "./use-chime";
import { useMerchantFeed, type MerchantFeed } from "./use-merchant-feed";
import { useMerchantSummary, type MerchantSummary } from "./use-merchant-summary";
import { useNowSeconds } from "./use-now";

/**
 * Everything the five screens share, held once at the shell.
 *
 * The feed in particular belongs here rather than on the settlements screen: the
 * sidebar's nav counts and its live dot are drawn from it on every screen, and a
 * merchant who wanders onto Settings mid-service should still hear the chime.
 * Hoisting it also means moving between screens does not tear down and re-open
 * the EventSource, which would replay rows and re-run the connect grace window.
 */

export type MerchantStatus = "loading" | "ready" | "missing" | "error";

interface MerchantContextValue {
  handle: string;
  merchant: MerchantResponse | null;
  status: MerchantStatus;
  error: string | null;
  reload(): void;
  /** After a profile save, so the sidebar's shop name updates without a refetch. */
  replace(next: MerchantResponse): void;
  feed: MerchantFeed;
  /**
   * The Overview's KPI figures. Held here beside `feed` rather than inside the
   * Overview screen because the sidebar's nav count reads it on every screen —
   * and because the two must be built from the same clock and the same rows, or
   * a badge and a tile would name different totals.
   */
  summary: MerchantSummary;
  chime: ChimeControl;
  /** The row the transaction drawer is showing; null when it is closed. */
  selected: SettlementEvent | null;
  select(row: SettlementEvent | null): void;
}

const MerchantContext = createContext<MerchantContextValue | null>(null);

export function useMerchantContext(): MerchantContextValue {
  const value = useContext(MerchantContext);
  if (value === null) throw new Error("useMerchantContext used outside the merchant shell");
  return value;
}

/**
 * The merchant record is fetched in the browser rather than in the server
 * layout on purpose. The public build's backend is a free-tier instance that
 * cold-starts in about a minute; a server-side fetch would turn that into a
 * failed render of the whole surface, where a client fetch is a card that says
 * what is happening and can be retried. It also keeps the shell one client tree,
 * so every screen reads the same record the sidebar is drawing.
 */
export function MerchantProvider({
  handle,
  children,
}: {
  handle: string;
  children: React.ReactNode;
}) {
  const [merchant, setMerchant] = useState<MerchantResponse | null>(null);
  const [status, setStatus] = useState<MerchantStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<SettlementEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    api
      .merchant(handle)
      .then((value) => {
        if (cancelled) return;
        setMerchant(value);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A handle nobody registered is a different screen from a backend that
        // is down: one offers onboarding, the other offers a retry.
        const missing = err instanceof ApiClientError && err.errorName === "MerchantNotFound";
        setError(err instanceof Error ? err.message : String(err));
        setStatus(missing ? "missing" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [handle, attempt]);

  const chime = useChime();
  // The feed already refuses rows for other merchants, so by the time this runs
  // the scope rule has been applied — there is nothing further to check here.
  const ringRef = useRef(chime.ring);
  ringRef.current = chime.ring;
  const onLive = useCallback(() => ringRef.current(), []);
  const feed = useMerchantFeed(handle, onLive);
  // One clock, so the month the tiles sum and the month the header names cannot
  // be a tick apart across a boundary. Recomputed per tick and not memoised: it
  // is a number, so every instant inside one month yields a value that compares
  // equal, and nothing downstream refires until the month actually rolls.
  const now = useNowSeconds();
  const monthStart = now === null ? null : monthStartUnixSeconds(now);
  const summary = useMerchantSummary(handle, feed.rows, monthStart);

  const reload = useCallback(() => setAttempt((previous) => previous + 1), []);
  const replace = useCallback((next: MerchantResponse) => {
    setMerchant(next);
    // `error` cleared here, not just `status`. Asserting readiness while leaving
    // a stale message armed underneath is safe only because the shell gates
    // screens on `status === "ready"`, so nothing that calls this can be mounted
    // in an error state — an invariant enforced in another file entirely. One
    // line makes it local instead.
    setError(null);
    setStatus("ready");
  }, []);

  const value = useMemo<MerchantContextValue>(
    () => ({
      handle,
      merchant,
      status,
      error,
      reload,
      replace,
      feed,
      summary,
      chime,
      selected,
      select: setSelected,
    }),
    [handle, merchant, status, error, reload, replace, feed, summary, chime, selected],
  );

  return <MerchantContext.Provider value={value}>{children}</MerchantContext.Provider>;
}

/** The shop's name, or its handle. Never an invented one — an unnamed merchant
 * is a real merchant, and the handle is the fact we actually have. */
export function shopName(merchant: MerchantResponse | null, handle: string): string {
  return merchant?.displayName ?? handle;
}
