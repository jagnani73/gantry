"use client";

import { CARD_FEE_BPS, GANTRY_FEE_BPS, basescanAddress, formatBps, formatUnits6 } from "@gantry/shared";
import { Card, Figure, Label, Mono } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { grouped, totalsOf } from "./format";
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

  return (
    <>
      <ScreenHeader title="Payouts">
        There is no payout schedule — each payment settles to your address in the same transaction.
      </ScreenHeader>

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.4fr_1fr]">
        <Card radius="card" pad="lg">
          <Label size="lg">Paid out to date</Label>
          <Figure units={totals.net} size="payout" className="mt-3.5" />
          <div className="mt-4 flex flex-wrap gap-9 border-t border-hairline pt-4">
            <Stat label="Gross">S${formatUnits6(totals.gross)}</Stat>
            <Stat label={`Gantry fee (${formatBps(GANTRY_FEE_BPS)})`}>
              −S${formatUnits6(totals.fees)}
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

        <Card radius="card" pad="lg" className="flex flex-col">
          <Label size="lg">Payout address</Label>
          <Mono size="md" breakAll className="mt-3.5 text-body-lg">
            {merchant?.payout}
          </Mono>
          <p className="mt-auto pt-4.5 text-meta text-muted">
            Set once, on-chain, at registration. Only this address can change it — the contract
            gates the rotation on the current payout, so nobody else can point your takings
            somewhere new.
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

      <Card radius="card" pad="lg">
        <div className="text-card-title-sm">By day</div>
        <p className="mt-2 max-w-[64ch] text-body text-muted">
          A day-by-day breakdown of gross, fee and net is still to come. Every payment above is
          already final and individually settled, so this is a summary that has yet to be built —
          not a payout that has yet to run.
        </p>
      </Card>
    </>
  );
}

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
