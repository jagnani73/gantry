"use client";

import Link from "next/link";
import { CARD_FEE_BPS, GANTRY_FEE_BPS, formatBps, type SettlementEvent } from "@gantry/shared";
import { CapMeter, Card, Figure, Label, StatusDot } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyPanel } from "./empty-panel";
import { feedStatusOf, rowsForToday, todayIsPartial } from "./feed-state";
import { grouped, longDate, plural, totalsOf } from "./format";
import { useMerchantContext } from "./merchant-context";
import { ScreenHeader } from "./screen-header";
import { SettlementFeedRow } from "./settlement-feed-row";
import { merchantHref } from "./screens";
import { settlementKey } from "./use-merchant-feed";
import { useNowSeconds } from "./use-now";

/** The counter view shows the day, not the book. Anything longer lives one click
 * away on Transactions. Eight is the count that was measured to reach the fold
 * on the 1440-wide window the design is drawn for, not a number the layout
 * enforces: a shorter viewport cuts the list off earlier. */
const FEED_LIMIT = 8;

const STATUS_TEXT = {
  accent: "text-accent",
  warning: "text-warning",
  danger: "text-danger",
} as const;

export function SettlementsScreen() {
  const { handle, feed, select } = useMerchantContext();
  const now = useNowSeconds();

  const today = rowsForToday(feed.rows, now);
  const status = feedStatusOf(feed.connection, today.length);
  const totals = totalsOf(today, CARD_FEE_BPS);
  const partial = todayIsPartial(today.length, feed.rows.length, feed.hasMore);

  return (
    <>
      <ScreenHeader
        title="Settlements"
        action={
          <div className="flex items-center gap-3.5">
            <span
              className={cn(
                "inline-flex items-center gap-1.75 text-meta",
                STATUS_TEXT[status.tone],
              )}
            >
              <StatusDot tone={status.tone} size="md" ring />
              {status.label}
            </span>
            <Button asChild size="sm">
              <Link href={merchantHref(handle, "qr")}>Show my QR</Link>
            </Button>
          </div>
        }
      >
        {now === null ? null : <>{longDate(now)} · </>}every payment lands as XSGD
      </ScreenHeader>

      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-[1.5fr_1fr_1fr]">
          <Card tone="accent" radius="card" pad="lg">
            <Label size="lg" tone="on-accent-muted">
              Collected today
            </Label>
            <Figure units={totals.net} size="kpi" tone="on-accent" className="mt-4" />
            <div className="mt-3.5 text-body-sm text-on-accent-body">
              {totals.count === 0
                ? "Nothing settled yet today"
                : `${plural(totals.count, "payment")} · net of the ${formatBps(GANTRY_FEE_BPS)} fee`}
            </div>
          </Card>

          <Card radius="card" pad="lg" className="flex flex-col justify-between gap-4">
            <Label size="lg">Paid by agents</Label>
            <div>
              <Figure
                value={totals.agentCount}
                prefix={null}
                size="sm"
                suffix={`of ${totals.count}`}
              />
              {/* Counts, fed to the meter as counts. `Units` is bigint | string
                  precisely to keep `number` away from money, so scaling these
                  into 6dp units would launder integers through a contract they
                  do not belong to — and the same expression over a float renders
                  "300000.00000000006", which `toUnits` throws on, mid-render. The
                  bar draws a ratio, which is scale-free; the caption overrides the
                  money-shaped default rather than reading "4.00 of 14.00". */}
              <CapMeter
                spent={BigInt(totals.agentCount)}
                cap={BigInt(totals.count)}
                aria-valuetext={`${totals.agentCount} of ${totals.count} payments came through the agent door`}
                className="mt-3"
              />
            </div>
          </Card>

          <Card radius="card" pad="lg" className="flex flex-col justify-between gap-4">
            <Label size="lg">Saved vs cards</Label>
            <div>
              <Figure units={totals.saved} size="sm" />
              <div className="mt-3 text-meta text-muted">
                against a {formatBps(CARD_FEE_BPS)} card rate
              </div>
            </div>
          </Card>
        </div>

        {/* Every figure above sums the rows this browser holds. Past one page
            that is a floor, not the day, and a merchant has no way to tell —
            so say it, and hand them the control that fixes it. */}
        {partial ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-fine text-faint">
              Covers the {grouped(feed.rows.length)} payments loaded so far, of{" "}
              {grouped(feed.total)}. Earlier payments from today are not in these figures yet.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={feed.loadMore}
              disabled={feed.loadingMore}
            >
              {feed.loadingMore ? "Loading…" : "Load older"}
            </Button>
          </div>
        ) : null}
      </div>

      <Card radius="card" pad="list">
        <div className="flex items-center justify-between gap-4 px-4 pt-3.5 pb-3">
          <span className="text-card-title-sm">Live feed</span>
          <Link
            href={merchantHref(handle, "transactions")}
            className="focus-ring rounded-badge text-meta"
          >
            All transactions →
          </Link>
        </div>
        <FeedBody limit={FEED_LIMIT} rows={today} onOpen={select} />
      </Card>
    </>
  );
}

function FeedBody({
  rows,
  limit,
  onOpen,
}: {
  rows: readonly SettlementEvent[];
  limit: number;
  onOpen(row: SettlementEvent): void;
}) {
  const { feed } = useMerchantContext();

  if (feed.connection === "disconnected") {
    return (
      <EmptyPanel
        title="The feed is disconnected"
        body="Payments are still settling on-chain. This screen simply cannot see them. The browser closed the stream rather than retrying, which means the backend answered with something other than a live event stream."
        action={
          <Button variant="destructive" size="sm" onClick={feed.retry}>
            Retry connection
          </Button>
        }
      />
    );
  }

  if (feed.historyStatus === "error") {
    return (
      <EmptyPanel
        title="Couldn't load today's payments"
        body={feed.historyError ?? "The settlement history request did not come back."}
        action={
          <Button variant="secondary" size="sm" onClick={feed.retry}>
            Try again
          </Button>
        }
      />
    );
  }

  if (feed.historyStatus === "loading" && rows.length === 0) {
    return <EmptyPanel glyph={false} title="Loading today's payments…" body="" />;
  }

  if (rows.length === 0) {
    return (
      <EmptyPanel
        title="No payments yet today"
        body="Settlements appear here the moment they land. Put the standee on the counter, or send an agent at your pay link."
      />
    );
  }

  return (
    <div>
      {rows.slice(0, limit).map((row) => (
        <SettlementFeedRow
          key={settlementKey(row)}
          row={row}
          fresh={feed.isFresh(row)}
          onOpen={() => onOpen(row)}
        />
      ))}
    </div>
  );
}
