"use client";

import Link from "next/link";
import { CARD_FEE_BPS, GANTRY_FEE_BPS, formatBps, type SettlementEvent } from "@gantry/shared";
import { CapMeter, Card, Figure, Label, StatusDot } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyPanel } from "./empty-panel";
import { feedStatusOf, rowsForToday } from "./feed-state";
import { longDate, plural, totalsOf } from "./format";
import { useMerchantContext } from "./merchant-context";
import { ScreenHeader } from "./screen-header";
import { SettlementFeedRow } from "./settlement-feed-row";
import { merchantHref } from "./screens";
import { settlementKey } from "./use-merchant-feed";
import { useNowSeconds } from "./use-now";

/** The counter view shows the day, not the book. Anything longer lives one click
 * away on Transactions, and eight rows is what fits above the fold at 1440. */
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
            {/* Counts scaled into the 6dp units the meter speaks. The ratio is
                what the bar draws; the readable version is spelled out for
                assistive tech rather than left as "4.00 of 14.00". */}
            <CapMeter
              spent={String(totals.agentCount * 1_000_000)}
              cap={String(totals.count * 1_000_000)}
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
        body="Payments are still settling on-chain — this screen simply cannot see them. The browser closed the stream rather than retrying, which means the backend answered with something other than a live event stream."
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
