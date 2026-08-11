"use client";

import { useMemo, useState } from "react";
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
import { clockTime, monthDay, netOf, plural, shortDate, tableDay, totalsOf } from "./format";
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
 * Search is a string match over the rows already loaded, NOT a server query.
 *
 * That is a deliberate limit and the copy says so: a merchant searching a hash
 * that predates the loaded pages gets nothing, and pretending otherwise would
 * mean shipping a search endpoint the backend does not have. The haystack is
 * built once per row and includes both the display and full-precision forms of
 * every amount, so "4.50" and "3.352955" both find the same payment.
 */
function haystackOf(row: SettlementEvent): string {
  return [
    row.payer,
    row.agentPayer ?? "",
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

  return (
    <>
      <ScreenHeader title="Transactions">
        {feed.hasMore
          ? `${plural(feed.total, "payment")} · showing the most recent ${feed.rows.length}`
          : `${plural(feed.total, "payment")}${oldest ? ` since ${monthDay(oldest.blockTime)}` : ""} · S$${formatUnits6(totals.net)} net`}
      </ScreenHeader>

      <div className="flex flex-wrap items-center gap-2.5">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by payer address, amount or tx hash"
          aria-label="Search loaded transactions"
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
        <Button
          variant="outline"
          onClick={() => downloadCsv(`gantry-${handle}-transactions.csv`, settlementsCsv(visible))}
          disabled={visible.length === 0}
          className="rounded-nav border-0"
        >
          Export CSV
        </Button>
      </div>

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
            title={filtered ? "Nothing matches that filter" : "No payments yet"}
            body={
              filtered
                ? "Nothing in the loaded history matches. Search runs over the pages already loaded, so an older payment may need loading first."
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
              <Mono size="md" tone="quiet" truncate>
                {shortAddress(row.agentPayer ?? row.payer)}
              </Mono>
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
