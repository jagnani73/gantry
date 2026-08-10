"use client";

import Link from "next/link";
import {
  CARD_FEE_BPS,
  GANTRY_FEE_BPS,
  OVERVIEW_WINDOW_DAYS,
  dayKey,
  formatBps,
  overviewWindowStart,
  windowIsPartial,
  type SettlementEvent,
} from "@gantry/shared";
import { Card, Figure, Label, StatusDot } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyPanel } from "./empty-panel";
import { feedStatusOf, rowsForOverviewWindow } from "./feed-state";
import { dayRangeLabel, grouped, plural, totalsOf } from "./format";
import { useMerchantContext } from "./merchant-context";
import { ScreenHeader } from "./screen-header";
import { SettlementFeedRow } from "./settlement-feed-row";
import { merchantHref } from "./screens";
import { settlementKey } from "./use-merchant-feed";
import { useNowSeconds } from "./use-now";

/** The counter view shows a rolling week, not the book. Anything longer lives one click
 * away on Transactions. Eight is the count that was measured to reach the fold
 * on the 1440-wide window the design is drawn for, not a number the layout
 * enforces: a shorter viewport cuts the list off earlier. */
const FEED_LIMIT = 8;

const STATUS_TEXT = {
  accent: "text-accent",
  warning: "text-warning",
  danger: "text-danger",
} as const;

export function OverviewScreen() {
  const { handle, feed, select } = useMerchantContext();
  const now = useNowSeconds();

  const windowRows = rowsForOverviewWindow(feed.rows, now);
  const status = feedStatusOf(feed.connection);
  const totals = totalsOf(windowRows, CARD_FEE_BPS);
  const partial = windowIsPartial(windowRows.length, feed.rows.length, feed.hasMore);

  return (
    <>
      <ScreenHeader
        title="Overview"
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
        {now === null ? null : (
          <>{dayRangeLabel(overviewWindowStart(now), dayKey(now))} · </>
        )}
        every payment lands as XSGD
      </ScreenHeader>

      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-[1.5fr_1fr_1fr]">
          <Card tone="accent" radius="card" pad="lg">
            <Label size="lg" tone="on-accent-muted">
              Collected, last {OVERVIEW_WINDOW_DAYS} days
            </Label>
            <Figure units={totals.net} size="kpi" tone="on-accent" className="mt-4" />
            <div className="mt-3.5 text-body-sm text-on-accent-body">
              {totals.count === 0
                ? `Nothing settled in the last ${OVERVIEW_WINDOW_DAYS} days`
                : `${plural(totals.count, "payment")} · net of the ${formatBps(GANTRY_FEE_BPS)} fee`}
            </div>
          </Card>

          <Card radius="card" pad="lg" className="flex flex-col justify-between gap-4">
            <Label size="lg">Paid by</Label>
            <DoorSplit agentCount={totals.agentCount} count={totals.count} />
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
            that is a floor, not the window's total, and a merchant has no way
            to tell — so say it, and hand them the control that fixes it. */}
        {partial ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-fine text-faint">
              Covers the {grouped(feed.rows.length)} most recent payments, out of{" "}
              {grouped(feed.total)} all time. Earlier payments inside this window are not in
              these figures yet.
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
        <FeedBody limit={FEED_LIMIT} rows={windowRows} nowSeconds={now} onOpen={select} />
      </Card>
    </>
  );
}

/**
 * The window's payments split by the door they came through.
 *
 * A proportion bar rather than the cap meter this used to be. A meter draws
 * "how much of an allowance is gone", and the agent share is not a budget being
 * consumed — both segments are payments the shop was glad to take. A two-part
 * bar says "these are the two halves of one total", which is the true shape.
 *
 * Both counts are printed as text beside the bar, so no QUANTITY on this tile
 * has to be decoded from colour. Matching a legend swatch back to its segment
 * still does, which is the honest limit here: accent against muted is a
 * lightness difference rather than a hue one and measures about 2.2:1, so it
 * does NOT clear WCAG 1.4.11's 3:1 for non-text contrast. That is acceptable
 * only because the bar is illustrating the counts rather than carrying them.
 * If this bar ever becomes the only place a number lives, it stops being true.
 */
function DoorSplit({ agentCount, count }: { agentCount: number; count: number }) {
  const humanCount = count - agentCount;
  // An empty window leaves both segments off and shows the bare track, rather
  // than dividing by zero or painting a full bar for nothing.
  const agentPercent = count === 0 ? 0 : (agentCount / count) * 100;
  // Both segments plus the 2px gap would total 2px over the track, so each
  // gives up half of it. With only one segment there is no gap to pay for.
  const split = agentCount > 0 && humanCount > 0;
  const agentWidth = split ? `calc(${agentPercent}% - 1px)` : "100%";
  const humanWidth = split ? `calc(${100 - agentPercent}% - 1px)` : "100%";

  return (
    <div>
      <div
        className="flex h-2.5 gap-0.5 rounded-full bg-fill-subtle"
        role="img"
        aria-label={
          count === 0
            ? `No payments in the last ${OVERVIEW_WINDOW_DAYS} days`
            : `${agentCount} of ${count} payments came through the agent door, ${humanCount} through the human door`
        }
      >
        {/* Widths are explicit and the fills never shrink: under `flex-1` the
            human segment would claim space on an empty window and squeeze the
            agent segment when every payment came through that door. A segment
            at zero is omitted entirely, so the 2px gap does not survive as a
            notch in a bar that is really one colour. */}
        {agentCount > 0 ? (
          <div
            className="h-full shrink-0 rounded-full bg-accent"
            style={{ width: agentWidth }}
          />
        ) : null}
        {humanCount > 0 ? (
          <div
            className="h-full shrink-0 rounded-full bg-muted"
            style={{ width: humanWidth }}
          />
        ) : null}
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-4">
        <span className="flex items-center gap-2 text-meta text-quiet">
          <span className="size-2 shrink-0 rounded-full bg-accent" />
          Agents <span className="text-ink tabular-nums">{grouped(agentCount)}</span>
        </span>
        <span className="flex items-center gap-2 text-meta text-quiet">
          <span className="size-2 shrink-0 rounded-full bg-muted" />
          Humans <span className="text-ink tabular-nums">{grouped(humanCount)}</span>
        </span>
      </div>
    </div>
  );
}

function FeedBody({
  rows,
  limit,
  nowSeconds,
  onOpen,
}: {
  rows: readonly SettlementEvent[];
  limit: number;
  nowSeconds: number | null;
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
        title={`Couldn't load the last ${OVERVIEW_WINDOW_DAYS} days`}
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
    return (
      <EmptyPanel glyph={false} title={`Loading the last ${OVERVIEW_WINDOW_DAYS} days…`} body="" />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyPanel
        title={`No payments in the last ${OVERVIEW_WINDOW_DAYS} days`}
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
          nowSeconds={nowSeconds}
          onOpen={() => onOpen(row)}
        />
      ))}
    </div>
  );
}
