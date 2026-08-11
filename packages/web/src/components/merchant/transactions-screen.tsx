"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CARD_FEE_BPS,
  formatUnits6,
  shortAddress,
  type SettlementEvent,
  type WireDoor,
} from "@gantry/shared";
import { Card, DoorChip, Label, Money, Mono, Row } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { downloadCsv, settlementsCsv } from "./csv";
import { EmptyPanel } from "./empty-panel";
import {
  clockTime,
  grouped,
  monthDay,
  netOf,
  plural,
  shortDate,
  tableDay,
  totalsOf,
} from "./format";
import { useMerchantContext } from "./merchant-context";
import { ScreenHeader } from "./screen-header";
import { settlementKey } from "./use-merchant-feed";

type DoorFilter = "all" | WireDoor;

const FILTERS: { id: DoorFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "human", label: "Human" },
  { id: "agent", label: "Agent" },
];

/** Six columns at 1440; the two mono detail columns drop out below `lg`, where
 * the table would otherwise crush the payer address it exists to show. */
const GRID =
  "grid grid-cols-[76px_66px_1fr_92px] items-center gap-4 lg:grid-cols-[96px_82px_1fr_150px_104px_108px]";

/**
 * Search is a string match in the browser, and the screen loads the whole book
 * behind it rather than shipping a server query.
 *
 * It used to search only the pages already fetched, which quietly made the
 * screen's own promise false — Transactions is "the whole book, searchable",
 * and a merchant hunting a hash from last week got an empty table that looked
 * exactly like no such payment.
 *
 * A `?q=` on `/api/settlements` was the obvious fix and is the wrong one: half
 * this haystack does not exist in the database. The S$ figures are computed
 * (`xsgdOut − feeXsgd`), the days are formatted in SGT, and "via facilitator" is
 * derived from the payer and the door — so a SQL `LIKE` would search a strictly
 * NARROWER set of fields while advertising a broader reach. Paging the rest in
 * keeps the matching exactly as rich as what is on screen, and the only cost is
 * a few more requests on a book this size.
 *
 * The haystack is built once per row and includes both the display and
 * full-precision forms of every amount, so "4.50" and "3.352955" both find the
 * same payment.
 */
function haystackOf(row: SettlementEvent): string {
  return [
    row.payer,
    // Searchable by the label the row actually shows, since the buyer's own
    // address does not exist on-chain for a bridged payment.
    row.bridged ? "via facilitator" : "",
    row.txHash,
    row.intentId,
    row.tokenSymbol ?? "",
    row.door,
    formatUnits6(BigInt(row.xsgdOut), 2),
    formatUnits6(BigInt(row.xsgdOut), 6),
    formatUnits6(BigInt(row.amountIn), 6),
    formatUnits6(netOf(row), 2),
    // Both spellings of the day, because the row shows one ("8 Aug") and the
    // drawer and CSV show the other ("8 Aug 2026") — a column the merchant can
    // read is a column they will type into.
    tableDay(row.blockTime),
    shortDate(row.blockTime),
    clockTime(row.blockTime),
  ]
    .join(" ")
    .toLowerCase();
}

export function TransactionsScreen() {
  const { handle, feed, select } = useMerchantContext();
  const [query, setQuery] = useState("");
  const [door, setDoor] = useState<DoorFilter>("all");

  const haystacks = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of feed.rows) map.set(settlementKey(row), haystackOf(row));
    return map;
  }, [feed.rows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return feed.rows.filter((row) => {
      if (door !== "all" && row.door !== door) return false;
      if (needle === "") return true;
      return (haystacks.get(settlementKey(row)) ?? "").includes(needle);
    });
  }, [feed.rows, haystacks, query, door]);

  const totals = totalsOf(feed.rows, CARD_FEE_BPS);
  const oldest = feed.rows[feed.rows.length - 1];
  const filtered = door !== "all" || query.trim() !== "";
  /** Filtering a partial book is the state that produces a wrong answer, so it
   * is the state that pulls the rest of it in. A stalled load is excluded: the
   * screen must not claim to still be reading when it has stopped. */
  const completing = filtered && feed.hasMore && feed.historyError === null;
  /**
   * Filtered, and the search is over a subset of the book.
   *
   * `feed.hasMore` alone was not enough and the gap was the worst possible one:
   * when the FIRST page fails, the cursor is never set, so `hasMore` is false
   * and this read as a complete search over the zero rows that were read. The
   * screen then asserted "Every page has been searched". `historyStatus` is the
   * only thing that distinguishes "read the whole book" from "read none of it".
   */
  const stalled = filtered && feed.historyStatus === "error";
  /** The only state in which an exhaustive claim is true: a read that succeeded
   * AND has no pages left. */
  const searchedEverything = feed.historyStatus === "ready" && !feed.hasMore;

  /**
   * Pages the remaining book in while a filter is active.
   *
   * A cascade rather than a loop: each page that lands flips `loadingMore` back
   * to false and moves the cursor, which re-runs this and fetches the next.
   * `loadMore` already refuses to run while one is in flight, so the effect
   * cannot stack requests even though it re-runs on every render — `feed` is a
   * fresh object each time, so this is not a rare path.
   *
   * **The `historyError` guard is what keeps that from becoming a hot loop.** A
   * failed page leaves the cursor exactly where it was and clears the in-flight
   * flag, so without it the two conditions above are true again immediately and
   * the screen retries a failing endpoint as fast as it can answer. The feed
   * clears the error itself on the next success, so this resumes rather than
   * latching off.
   *
   * Deliberately uncapped otherwise. A bound would be a silent one — the
   * merchant would see a complete-looking result set that had stopped early —
   * and the alternative to silence is a caveat on every search on the one screen
   * whose job is to be exhaustive. The progress line says what is happening
   * instead, and clearing the box stops it.
   */
  const { hasMore, loadingMore, loadMore, historyError } = feed;
  useEffect(() => {
    if (!filtered || !hasMore || loadingMore || historyError !== null) return;
    loadMore();
  }, [filtered, hasMore, loadingMore, loadMore, historyError]);

  return (
    <>
      <ScreenHeader title="Transactions">
        {completing
          ? // Says which of the two things is true, because they lead to
            // different actions: results still arriving means wait, and a
            // finished search means the answer is no.
            `${plural(feed.total, "payment")} · reading them all to search — ${grouped(feed.rows.length)} so far`
          : feed.hasMore
            ? `${plural(feed.total, "payment")} · showing the most recent ${feed.rows.length}`
            : `${plural(feed.total, "payment")}${oldest ? ` since ${monthDay(oldest.blockTime)}` : ""} · S$${formatUnits6(totals.net)} net`}
      </ScreenHeader>

      <div className="flex flex-wrap items-center gap-2.5">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by payer address, amount or tx hash"
          aria-label="Search transactions"
          className="focus-ring text-body min-w-0 flex-1 rounded-nav bg-surface px-4 py-2.75 text-ink placeholder:text-faint"
        />
        <div role="group" aria-label="Door" className="flex gap-1.5 rounded-nav bg-surface p-1">
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              aria-pressed={door === filter.id}
              onClick={() => setDoor(filter.id)}
              className={cn(
                "focus-ring text-meta rounded-chip-sm px-3.5 py-1.75 transition-colors",
                door === filter.id ? "bg-fill-subtle text-ink" : "text-muted hover:text-ink",
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
        {/* Disabled while the book is still paging in. The CSV is the one
            artifact that LEAVES the screen, so it loses every caveat attached
            to it — and a merchant reconciling books is exactly who would treat
            a partial file as the answer. A stalled read is allowed through,
            because there the alternative is no export at all, but the banner
            above it says what is missing. */}
        <Button
          variant="outline"
          onClick={() => downloadCsv(`gantry-${handle}-transactions.csv`, settlementsCsv(visible))}
          disabled={visible.length === 0 || completing}
          className="rounded-nav border-0"
        >
          {completing ? "Loading…" : "Export CSV"}
        </Button>
      </div>

      {/* Rendered whether or not the partial set happens to contain a match.
          Gated only on the empty state, this caveat was invisible in precisely
          the case where a merchant acts on the results: some rows, and no
          statement that they are a subset. */}
      {stalled ? (
        <Card tone="danger" radius="control-m" pad="none" className="px-4.5 py-3.5">
          <p className="text-meta">
            The history stopped loading, so this is a search over the{" "}
            {grouped(feed.rows.length)} payments already loaded — not the whole book. Anything
            older has not been checked.
          </p>
        </Card>
      ) : null}

      <Card radius="card" pad="none" className="p-2 pb-3.5">
        <div className={cn(GRID, "border-b border-fill-subtle px-4 pt-3.5 pb-2.5")}>
          <Label size="col-header" tone="faintest">
            When
          </Label>
          <Label size="col-header" tone="faintest">
            Door
          </Label>
          <Label size="col-header" tone="faintest">
            Payer
          </Label>
          <Label size="col-header" tone="faintest" className="hidden text-right lg:block">
            Received in
          </Label>
          <Label size="col-header" tone="faintest" className="hidden text-right lg:block">
            Fee
          </Label>
          <Label size="col-header" tone="faintest" className="text-right">
            Amount
          </Label>
        </div>

        {visible.length === 0 ? (
          <EmptyPanel
            glyph={false}
            title={
              completing
                ? "Still reading the book…"
                : stalled
                  ? "Couldn't finish searching"
                  : filtered
                    ? "Nothing matches that filter"
                    : "No payments yet"
            }
            body={
              completing
                ? // Never "no results" while pages are outstanding: that is a
                  // verdict on rows this browser has not seen yet, and it is the
                  // answer a merchant would act on.
                  `Loaded ${grouped(feed.rows.length)} of ${grouped(feed.total)} payments so far. Nothing has matched yet.`
                : stalled
                  ? // The distinction that matters: this is not "no such
                    // payment", it is "we could not look at all of them".
                    `The history stopped loading, so only ${grouped(feed.rows.length)} payments were searched. The rest have not been checked.`
                  : filtered
                    ? searchedEverything
                      ? "No payment in this shop's history matches. Every page has been searched, not just the ones on screen."
                      : "No match among the payments loaded so far."
                    : "Settlements land here as they happen, through the printed QR or the x402 door."
            }
          />
        ) : (
          visible.map((row) => (
            <Row
              key={settlementKey(row)}
              interactive
              pad="tight"
              highlight={feed.isFresh(row)}
              onClick={() => select(row)}
              className={GRID}
            >
              {/* Stacked rather than widened: this table already gives its two
                  mono detail columns up below `lg`, so the width a one-line
                  "8 Aug 14:32:07" needs would come out of the payer column the
                  table exists to show. Both lines are Mono, so the day and the
                  clock stay on one tabular grid and the column does not shimmer
                  as seconds tick. */}
              <div className="flex min-w-0 flex-col gap-0.5">
                <Mono size="3xs" tone="faintest">
                  {tableDay(row.blockTime)}
                </Mono>
                <Mono size="sm" tone="muted">
                  {clockTime(row.blockTime)}
                </Mono>
              </div>
              <span>
                <DoorChip door={row.door} variant="pill" />
              </span>
              {row.bridged ? (
                <span className="truncate text-body-sm text-quiet">via facilitator</span>
              ) : (
                <Mono size="md" tone="quiet" truncate>
                  {shortAddress(row.payer)}
                </Mono>
              )}
              <Money
                variant="token"
                size="md"
                units={row.amountIn}
                dp={6}
                suffix={row.tokenSymbol}
                tone="faint"
                className="hidden text-right lg:block"
              />
              <Money
                variant="token"
                size="md"
                units={row.feeXsgd}
                dp={4}
                tone="faintest"
                className="hidden text-right lg:block"
              />
              <Money units={row.xsgdOut} prefix="S$" size="md" className="text-right" />
            </Row>
          ))
        )}

        <div className="mt-2 flex items-center justify-between gap-4 border-t border-fill-subtle px-4 pt-4 text-meta text-muted">
          <span>
            Showing {visible.length} of {plural(feed.total, "payment")}
          </span>
          {feed.hasMore ? (
            <button
              type="button"
              onClick={feed.loadMore}
              disabled={feed.loadingMore}
              className="focus-ring rounded-badge text-accent hover:text-accent-hover disabled:text-faint"
            >
              {feed.loadingMore ? "Loading…" : "Load older →"}
            </button>
          ) : null}
        </div>
        {feed.historyError ? (
          <p className="px-4 pt-2 text-meta-sm text-danger">{feed.historyError}</p>
        ) : null}
      </Card>
    </>
  );
}
