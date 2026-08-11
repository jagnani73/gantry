"use client";

import {
  CARD_FEE_BPS,
  GANTRY_FEE_BPS,
  basescanAddress,
  formatBps,
  formatUnits6,
} from "@gantry/shared";
import { Card, Figure, Label, Mono } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { grouped, shortDate, totalsByDay, totalsOf } from "./format";
import { useMerchantContext } from "./merchant-context";
import { ScreenHeader } from "./screen-header";

/**
 * There is genuinely nothing to schedule here, and that is the point of the
 * screen rather than a gap in it: `_settle` pays the merchant inside the same
 * transaction that pulls the payer's funds, so "payouts" is a view of what has
 * already happened, not a queue of what is pending.
 */
export function PayoutsScreen() {
  const { merchant, feed } = useMerchantContext();
  const totals = totalsOf(feed.rows, CARD_FEE_BPS);
  const days = totalsByDay(feed.rows);
  /** Every figure on this screen except the payout address is derived from the
   * settlement feed, so a failed read makes all of them fiction. */
  const failedRead = feed.historyStatus === "error";

  return (
    <>
      <ScreenHeader title="Payouts">
        There is no payout schedule. Each payment settles to your address in the same transaction.
      </ScreenHeader>

      {/* A failed history read must not become "S$0.00 paid out to date" beside
          "Nothing has settled yet". Those are the two largest claims on the
          screen and both would be manufactured from a request that never came
          back — the same rule Overview already applies, which makes this an
          omission rather than a difference in house style. The payout card
          stays: it reads the merchant record, not the feed, so it is unaffected
          and it is the thing a merchant most needs when the rest is broken. */}
      {feed.historyStatus === "error" ? (
        <Card radius="card" pad="lg">
          <Label size="lg">Paid out to date</Label>
          <p className="mt-3 max-w-[64ch] text-body text-muted">
            The settlement history didn&apos;t load, so there is no total to show. This says
            nothing about what has settled. Every payment is final on-chain either way.
          </p>
          <p className="mt-2 text-fine text-faint">{feed.historyError}</p>
          <Button variant="secondary" size="sm" className="mt-4 w-fit" onClick={feed.retry}>
            Try again
          </Button>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.4fr_1fr]">
        {failedRead ? null : (
        <Card radius="card" pad="lg">
          <Label size="lg">Paid out to date</Label>
          <Figure units={totals.net} size="payout" className="mt-3.5" />
          <div className="mt-4 flex flex-wrap gap-9 border-t border-hairline pt-4">
            <Stat label="Gross">S${formatUnits6(totals.gross)}</Stat>
            {/* FOUR decimals. A 0.5% fee on a 2dp price is a 4dp number — 0.5%
                of S$29.50 is S$0.1475 — so 2dp truncated it to "0.14" and the
                three figures beside each other missed by a whole cent (29.50 −
                0.14 = 29.36, not 29.35). The money was always exact; the
                display lost three-quarters of a cent, and a fee is the one
                figure where truncating understates what was taken.

                This does NOT make the row reconcile, and it is not meant to:
                `formatUnits6` truncates, so 29.50 − 0.1475 is 29.3525 against a
                displayed net of 29.35. It takes the visible error from 0.01 to
                0.0025 and shows the precision the fee actually has. Reconciling
                exactly at a fixed 2dp cannot be done without deriving one of
                the three from the other two, which would mean printing a number
                the chain never produced.

                The rest of the app already agreed on 4dp here — the
                transactions table and its drawer both do — so this brings the
                lone outlier into line rather than inventing a convention. */}
            <Stat label={`Gantry fee (${formatBps(GANTRY_FEE_BPS)})`}>
              −S${formatUnits6(totals.fees, 4)}
            </Stat>
            <Stat label="Payments">{grouped(totals.count)}</Stat>
          </div>
          {/* The figure sums the rows this browser has loaded. While pages remain
              it is a floor, not a total, and saying so is cheaper than being
              quietly wrong about how much a shop has taken. */}
          {feed.hasMore ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-fine text-faint">
                Covers the {grouped(feed.rows.length)} payments loaded so far, of{" "}
                {grouped(feed.total)}.
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
        </Card>
        )}

        {/* Read-only here. Changing where the money goes is a configuration
            change, and an irreversible one, so the control lives on Settings
            rather than on the screen a merchant opens to check their takings. */}
        <Card radius="card" pad="lg" className="flex flex-col">
          <Label size="lg">Payout address</Label>
          <Mono size="md" breakAll className="mt-3.5 text-body-lg">
            {merchant?.payout}
          </Mono>
          <p className="mt-auto pt-4.5 text-meta text-muted">
            Every payment settles straight here inside the same transaction. Changing it is signed
            by this address itself, so nobody else can point your takings somewhere new, including
            us. You can change it in Settings.
          </p>
          {merchant ? (
            <a
              className="focus-ring mt-3 w-fit rounded-badge text-body"
              href={basescanAddress(merchant.payout)}
              target="_blank"
              rel="noreferrer"
            >
              View on Basescan ↗
            </a>
          ) : null}
        </Card>
      </div>

      {failedRead ? null : (
      <Card radius="card" pad="lg">
        <div className="text-card-title-sm">By day</div>
        {days.length === 0 ? (
          <p className="mt-2 max-w-[64ch] text-body text-muted">
            Nothing has settled yet. Each payment appears here on the day it landed, already paid
            out.
          </p>
        ) : (
          <>
            <div className="mt-4 overflow-x-auto">
              <div className="min-w-[420px]">
                <div className={cn(DAY_GRID, "border-b border-hairline pb-2.5")}>
                  <Label>Day</Label>
                  <Label className="text-right">Payments</Label>
                  <Label className="text-right">Gross</Label>
                  <Label className="text-right">Fee</Label>
                  <Label className="text-right">Net</Label>
                </div>
                {days.map((day) => (
                  <div key={day.day} className={cn(DAY_GRID, "border-b border-hairline py-3.25 last:border-b-0")}>
                    <span className="text-row-title">{shortDate(day.at)}</span>
                    <Mono size="sm" className="text-right">
                      {grouped(day.count)}
                    </Mono>
                    <Mono size="sm" className="text-right">
                      S${formatUnits6(day.gross)}
                    </Mono>
                    {/* 4dp — see the totals card above for why. */}
                    <Mono size="sm" tone="faint" className="text-right">
                      −S${formatUnits6(day.fees, 4)}
                    </Mono>
                    <Mono size="sm" className="text-right">
                      S${formatUnits6(day.net)}
                    </Mono>
                  </div>
                ))}
              </div>
            </div>
            {/* The oldest day on screen is the one still being loaded into, so
                it is the one figure here that can only go up. Naming it beats a
                blanket caveat over rows that are already complete. */}
            {feed.hasMore && days.length > 0 ? (
              <p className="mt-3.5 text-fine text-faint">
                Older payments have not been loaded, so {shortDate(days[days.length - 1]!.at)} is a
                partial day.
              </p>
            ) : null}
          </>
        )}
      </Card>
      )}
    </>
  );
}

/** Five columns, and the day is the only one that is not a figure. Every number
 * is right-aligned so the decimal points line up down the column, which is the
 * whole reason to render this as a table rather than as cards. */
const DAY_GRID = "grid grid-cols-[1fr_72px_92px_108px_92px] items-center gap-3";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-meta-sm text-faint">{label}</div>
      <Mono size="md" className="mt-1 block">
        {children}
      </Mono>
    </div>
  );
}
