"use client";

import { GANTRY_FEE_BPS, basescanAddress, formatBps, formatUnits6 } from "@gantry/shared";
import { Card, Figure, Label, Mono } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { grouped, plural, shortDate, totalsByDay } from "./format";
import { useMerchantContext } from "./merchant-context";
import { ScreenHeader } from "./screen-header";
import { SINCE_ALL_TIME, useMerchantSummary } from "./use-merchant-summary";

/**
 * There is genuinely nothing to schedule here, and that is the point of the
 * screen rather than a gap in it: `_settle` pays the merchant inside the same
 * transaction that pulls the payer's funds, so "payouts" is a view of what has
 * already happened, not a queue of what is pending.
 */
export function PayoutsScreen() {
  const { handle, merchant, feed } = useMerchantContext();
  /**
   * LIFETIME, from the server — not a sum of the rows this browser has loaded.
   *
   * "Paid out to date" is a claim about everything a shop has ever taken, so
   * summing a page of it was the same mistake the Overview tiles carried: the
   * headline moved with the page size, and on a book past one page it read as a
   * total while being a floor. The shell's `summary` is the MONTH; this asks the
   * same endpoint the same question with a different bound.
   */
  const lifetime = useMerchantSummary(handle, feed.rows, SINCE_ALL_TIME);
  const totals = lifetime.totals;
  /** The "By day" table below still sums loaded rows — it is a breakdown of the
   * feed, not a total — so it keeps the feed's own failure state. */
  const days = totalsByDay(feed.rows);
  const failedRead = feed.historyStatus === "error";

  return (
    <>
      <ScreenHeader title="Payouts">
        There is no payout schedule. Each payment settles to your address in the same transaction.
      </ScreenHeader>

      {/* A failed summary must not become "S$0.00 paid out to date". That is the
          largest claim on the screen and it would be manufactured from a request
          that never came back — the same rule Overview applies. The payout card
          stays: it reads the merchant record, not this, so it is unaffected and
          it is the thing a merchant most needs when the rest is broken. */}
      {lifetime.status === "error" ? (
        <Card radius="card" pad="lg">
          <Label size="lg">Paid out to date</Label>
          <p className="mt-3 max-w-[64ch] text-body text-muted">
            The totals didn&apos;t load, so there is no figure to show. This says nothing about
            what has settled. Every payment is final on-chain either way.
          </p>
          <p className="mt-2 text-fine text-faint">{lifetime.error}</p>
          <Button variant="secondary" size="sm" className="mt-4 w-fit" onClick={lifetime.retry}>
            Try again
          </Button>
        </Card>
      ) : (
        /* The same three-up grid Overview uses, with the same weights: one
           accent card carrying the figure a merchant came for, two plain cards
           carrying what it is made of. Matching it is the point — these are the
           same kind of claim about the same book, and two different treatments
           on two screens read as two different kinds of number. */
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-[1.5fr_1fr_1fr]">
          <Card tone="accent" radius="card" pad="lg">
            <Label size="lg" tone="on-accent-muted">
              Paid out to date
            </Label>
            <Figure units={totals.net} size="payout" tone="on-accent" className="mt-4" />
            <div className="mt-3.5 text-body-sm text-on-accent-body">
              {totals.count === 0
                ? "Nothing has settled yet"
                : `${plural(totals.count, "payment")} · net of the ${formatBps(GANTRY_FEE_BPS)} fee`}
            </div>
          </Card>

          <Card radius="card" pad="lg" className="flex flex-col justify-between gap-4">
            <Label size="lg">Gross collected</Label>
            <div>
              <Figure units={totals.gross} size="sm" />
              <div className="mt-3 text-meta text-muted">before the fee comes off</div>
            </div>
          </Card>

          <Card radius="card" pad="lg" className="flex flex-col justify-between gap-4">
            <Label size="lg">Gantry fee</Label>
            <div>
              {/* FOUR decimals. A 0.5% fee on a 2dp price is a 4dp number — 0.5%
                  of S$29.50 is S$0.1475 — so 2dp truncated it to "0.14" and the
                  three figures missed by a whole cent (29.50 − 0.14 = 29.36, not
                  29.35). The money was always exact; the display lost
                  three-quarters of a cent, and a fee is the one figure where
                  truncating understates what was taken.

                  This does NOT make the three cards reconcile, and is not meant
                  to: `formatUnits` truncates, so 29.50 − 0.1475 is 29.3525
                  against a displayed net of 29.35. It takes the visible error
                  from 0.01 to 0.0025 and shows the precision the fee actually
                  has. Reconciling exactly at a fixed 2dp cannot be done without
                  deriving one of the three from the other two, which would mean
                  printing a number the chain never produced. */}
              <Figure units={totals.fees} dp={4} size="sm" prefix="−S$" />
              <div className="mt-3 text-meta text-muted">
                {formatBps(GANTRY_FEE_BPS)} of gross, taken in the same transaction
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Read-only here. Changing where the money goes is a configuration
          change, and an irreversible one, so the control lives on Settings
          rather than on the screen a merchant opens to check their takings. */}
      <Card radius="card" pad="lg" className="flex flex-col">
        <Label size="lg">Payout address</Label>
        <Mono size="md" breakAll className="mt-3.5 text-body-lg">
          {merchant?.payout}
        </Mono>
        <p className="mt-auto max-w-[80ch] pt-4.5 text-meta text-muted">
          Every payment settles straight here inside the same transaction. Changing it is signed by
          this address itself, so nobody else can point your takings somewhere new, including us.
          You can change it in Settings.
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
            {/* This table sums the rows this browser has loaded, while the cards
                above sum the whole book on the server — so past one page the
                two DISAGREE, and the difference is real money. That has to be
                stated here rather than left for a merchant to notice: the
                headline is the total, and these are the days of it that have
                been fetched.

                The "Load older" control lives here now, beside the figures it
                actually changes. On the headline it implied the total was
                incomplete, which is no longer true.

                The oldest day on screen is also the one still being loaded
                into, so it is the one row that can only go up — naming it beats
                a blanket caveat over rows that are already complete. */}
            {feed.hasMore && days.length > 0 ? (
              <div className="mt-3.5 flex flex-wrap items-center gap-3">
                <p className="text-fine text-faint">
                  Covers the {grouped(feed.rows.length)} most recent payments, of{" "}
                  {grouped(feed.total)} — so {shortDate(days[days.length - 1]!.at)} is a partial day
                  and earlier days are missing. The totals above cover all of them.
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
