"use client";

import Link from "next/link";
import {
  CARD_FEE_BPS,
  GANTRY_FEE_BPS,
  formatBps,
  type SettlementEvent,
} from "@gantry/shared";
import { Card, Figure, Label, StatusDot } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyPanel } from "./empty-panel";
import { feedStatusOf } from "./feed-state";
import { grouped, monthLabel, monthStartLabel, plural } from "./format";
import { useMerchantContext } from "./merchant-context";
import { ScreenHeader } from "./screen-header";
import { SettlementFeedRow } from "./settlement-feed-row";
import { merchantHref } from "./screens";
import { settlementKey } from "./use-merchant-feed";
import { useNowSeconds } from "./use-now";

/**
 * How many settlements the live feed shows before "All transactions".
 *
 * A COUNT, deliberately, and no longer filtered to the window above it. The
 * tiles answer "how has this month gone" and the feed answers "what just
 * happened" — two different questions, which is exactly what the old shared
 * array got wrong. Keeping the feed on the month would also empty it at 00:00 on
 * the 1st, blanking the one panel on the screen whose job is to show the shop is
 * still trading.
 *
 * Ten rather than the previous eight: eight was measured to reach the fold on
 * the 1440-wide window the design is drawn for, and a couple of rows past the
 * fold is the right side to err on for a list that is scrolled rather than
 * counted.
 */
const FEED_LIMIT = 10;

const STATUS_TEXT = {
  accent: "text-accent",
  warning: "text-warning",
  danger: "text-danger",
} as const;

export function OverviewScreen() {
  const { handle, feed, summary, select } = useMerchantContext();
  const now = useNowSeconds();

  const status = feedStatusOf(feed.connection);
  const totals = summary.totals;
  // A failed summary must not become a confident S$0.00. The figures are summed
  // over the whole book on the server, so there is no local fallback that would
  // be anything but a smaller, wrong number — say so and offer the retry.
  const failedSummary = summary.status === "error";

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
        {now === null ? null : <>{monthLabel(now)} · </>}
        every payment lands as XSGD
      </ScreenHeader>

      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-[1.5fr_1fr_1fr]">
          <Card tone="accent" radius="card" pad="lg">
            <Label size="lg" tone="on-accent-muted">
              Collected, this month
            </Label>
            <Figure units={totals.net} size="kpi" tone="on-accent" className="mt-4" />
            <div className="mt-3.5 text-body-sm text-on-accent-body">
              {/* The empty state names the BOUNDARY rather than saying "no
                  payments". A calendar window resets itself, so at 09:00 on the
                  1st this reads zero over a shop that traded all last month —
                  which is true, and indistinguishable from a broken dashboard
                  unless the sentence says where the window starts. That
                  ambiguity was the whole objection to a calendar window; naming
                  the date is what answers it. */}
              {totals.count === 0
                ? now === null
                  ? "Nothing settled yet this month"
                  : `Nothing settled since ${monthStartLabel(now)}`
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

        {/* There is no "loaded so far" caveat here any more, and its absence is
            the point: these figures are summed over the whole book on the
            server, so they are exact at any size and no amount of paging in the
            feed below can change them. The only thing that can now make them
            wrong is the request failing, which is what this says. */}
        {failedSummary ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-fine text-faint">
              This month&apos;s totals didn&apos;t load, so the figures above may be behind. This
              says nothing about what has settled — every payment is final on-chain either way.
              {summary.error ? ` ${summary.error}` : ""}
            </p>
            <Button variant="secondary" size="sm" onClick={summary.retry}>
              Try again
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
        {/* `feed.rows`, not the month's rows: the newest payments, whichever
            month they fell in. See FEED_LIMIT. */}
        <FeedBody limit={FEED_LIMIT} rows={feed.rows} nowSeconds={now} onOpen={select} />
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
            ? "No payments this month"
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
        title="Couldn't load recent payments"
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
    return <EmptyPanel glyph={false} title="Loading recent payments…" body="" />;
  }

  // This is the whole book being empty, not the month — the feed is no longer
  // filtered to the window, so a shop that traded last month but not this one
  // shows its last payments here rather than an empty panel contradicting them.
  if (rows.length === 0) {
    return (
      <EmptyPanel
        title="No payments yet"
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
