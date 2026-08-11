"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { Address, Hex } from "viem";
import {
  CARD_FEE_BPS,
  GANTRY_FEE_BPS,
  basescanAddress,
  basescanTx,
  formatBps,
  formatUnits6,
  normalizePayout,
  shortAddress,
} from "@gantry/shared";
import { Card, Figure, Label, Mono, useToast } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { UnknownOutcomeError } from "@/lib/confirm-tx";
import { cn } from "@/lib/utils";
import { grouped, shortDate, totalsByDay, totalsOf } from "./format";
import { useMerchantContext } from "./merchant-context";
import { usePayoutWrites } from "./payout-writes";
import { ScreenHeader } from "./screen-header";

/**
 * Loaded only when a merchant actually opens the rotation form.
 *
 * A static import put RainbowKit's whole connector modal into this screen's
 * first load — 151 kB to 369 kB — for a control that most merchants will never
 * touch, on the surface most likely to be left open on a counter behind a venue
 * hotspot. The wagmi hooks the write itself uses are far lighter and stay
 * static; it is the wallet-picker UI that is worth deferring.
 *
 * `ssr: false` because it reads browser wallet state and has nothing to render
 * on a server.
 */
const ConnectButton = dynamic(
  () => import("@rainbow-me/rainbowkit").then((mod) => mod.ConnectButton),
  {
    ssr: false,
    loading: () => <span className="text-meta text-faint">Loading wallet options…</span>,
  },
);

/**
 * There is genuinely nothing to schedule here, and that is the point of the
 * screen rather than a gap in it: `_settle` pays the merchant inside the same
 * transaction that pulls the payer's funds, so "payouts" is a view of what has
 * already happened, not a queue of what is pending.
 */
export function PayoutsScreen() {
  const { feed } = useMerchantContext();
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
            nothing about what has settled — every payment is final on-chain either way.
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
        )}

        <PayoutCard />
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
                    <Mono size="sm" tone="faint" className="text-right">
                      −S${formatUnits6(day.fees)}
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
const DAY_GRID = "grid grid-cols-[1fr_72px_92px_92px_92px] items-center gap-3";

/** How long to keep asking the backend to catch up with a rotation we have a
 * receipt for. Sized like the payer app's policy read-back: the TTL is 60s but
 * the cached entry is usually mid-life, and a merchant is not going to watch a
 * minute of spinner either way. */
const PAYOUT_REREAD_ATTEMPTS = 6;
const PAYOUT_REREAD_POLL_MS = 2_000;

/**
 * Where the money lands, and the one control in this back-office that the chain
 * authenticates.
 *
 * `setMerchantPayout` is gated on `msg.sender == merchant.payout`, so the form
 * only works for someone holding the key that is already being paid. That is not
 * a login — nothing here knows who a merchant is — but it is the right shape of
 * guard for this particular action, and it is the reason this screen can offer a
 * write at all while the rest of the back-office stays read-only.
 */
function PayoutCard() {
  const { merchant, replace } = useMerchantContext();
  const { signer, setMerchantPayout } = usePayoutWrites();
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<{
    text: string;
    txHash: Hex;
    /** What the unconfirmed transaction was trying to set. Rendered beside the
     * current address, because "your payout is X" with no caveat is a claim we
     * cannot make while a write for Y is outstanding. */
    attempted: Address;
  } | null>(null);
  /**
   * The address this browser rotated to and saw mined, while the backend still
   * disagrees.
   *
   * `getMerchant` is served from a 60s TTL cache and the backend never observes
   * this write — it is signed in the browser — so a re-read straight after a
   * confirmed receipt routinely answers with the OLD payout. A mined receipt
   * outranks a cached read, so this drives a bounded poll until the two agree.
   */
  const [rotatedTo, setRotatedTo] = useState<Address | null>(null);

  /**
   * Re-reads the merchant until the backend reports the address we just wrote.
   *
   * This exists because the obvious version was wrong in a way that undid the
   * whole card: it called `reload()`, which sets the context to `"loading"`,
   * and the shell swaps every screen for its gate on that — so `PayoutCard`
   * UNMOUNTED, `rotatedTo` was destroyed, and the remount rendered the stale
   * cached payout as current, under a toast saying the change had succeeded.
   *
   * `replace` is the tool the context provides for exactly this: it sets the
   * record without a status transition, so nothing unmounts and the SIDEBAR —
   * which renders `merchant.payout` straight from context and knows nothing
   * about this card — stops disagreeing with the card beside it.
   */
  const handle = merchant?.handle;
  useEffect(() => {
    if (!rotatedTo || !handle) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const fresh = await api.merchant(handle);
        if (cancelled) return;
        if (fresh.payout.toLowerCase() === rotatedTo.toLowerCase()) {
          // Adopt the whole fresh record, not just the payout: it is now the
          // authoritative one and may carry other edits made elsewhere.
          replace(fresh);
          setRotatedTo(null);
          return;
        }
      } catch (err) {
        // A failed re-read says nothing about the rotation, which is mined. Keep
        // rendering the confirmed address and try again.
        console.warn("gantry: could not re-read the merchant after a payout rotation", err);
      }
      if (cancelled) return;
      attempt += 1;
      if (attempt >= PAYOUT_REREAD_ATTEMPTS) {
        // Give up on the READ, never on the fact. The optimistic record stands —
        // we hold its receipt — and only the "catching up" note goes away.
        console.warn("gantry: backend still reports the previous payout after a confirmed rotation");
        setRotatedTo(null);
        return;
      }
      timer = setTimeout(() => void tick(), PAYOUT_REREAD_POLL_MS);
    };
    timer = setTimeout(() => void tick(), PAYOUT_REREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `handle`, not `merchant`: the optimistic `replace` below changes the
    // record's identity, and depending on the object would tear this poll down
    // and restart it — resetting its own attempt counter every time it made
    // progress.
  }, [rotatedTo, handle, replace]);

  if (!merchant) return <Card radius="card" pad="lg" className="flex flex-col" />;

  const settled = rotatedTo === null;
  const shown = rotatedTo ?? merchant.payout;
  const isPayout = signer !== null && signer.toLowerCase() === merchant.payout.toLowerCase();

  const submit = async () => {
    const parsed = normalizePayout(next);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    if (parsed.address.toLowerCase() === merchant.payout.toLowerCase()) {
      setError("That is already this shop's payout address, so there is nothing to change.");
      return;
    }
    setError(null);
    setUnresolved(null);
    setBusy(true);
    try {
      await setMerchantPayout(merchant.merchantId, parsed.address);
      // Optimistic, and justified: we hold a mined receipt, which outranks a
      // cached read. Through `replace` rather than `reload` so the record moves
      // WITHOUT a status transition — the sidebar footer renders
      // `merchant.payout` from this same context and would otherwise keep
      // showing the old address beside a card showing the new one.
      replace({ ...merchant, payout: parsed.address });
      setRotatedTo(parsed.address);
      setEditing(false);
      setNext("");
      toast.success("Payouts now go to the new address.");
    } catch (err) {
      if (err instanceof UnknownOutcomeError) {
        // Never red, and never a blind retry: if it did land, the old address is
        // no longer the payout and a second attempt from the same wallet is
        // refused by the contract — which reads as a failure of the rotation
        // rather than as proof it already worked.
        setUnresolved({
          text: "The change was submitted and we couldn't confirm it in time. It may still be landing. Check the transaction before sending it again — if it did land, this wallet can no longer make the change, because it is no longer the payout address, and a second attempt would be refused for that reason rather than because the first one failed.",
          txHash: err.txHash,
          attempted: parsed.address,
        });
        // Collapse the form. An unresolved write must not invite a blind retry,
        // and an enabled submit button still pre-filled with the same address
        // is an invitation whatever the prose above it says.
        setEditing(false);
        setNext("");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card radius="card" pad="lg" className="flex flex-col">
      <Label size="lg">Payout address</Label>
      <Mono size="md" breakAll className="mt-3.5 text-body-lg">
        {shown}
      </Mono>
      {!settled ? (
        <p className="mt-2 text-fine text-faint">
          Confirmed on-chain just now. This screen reads through a short cache, so it may take a
          moment to agree.
        </p>
      ) : null}
      {/* An unresolved write means the address above may already be wrong, and
          the card must not present it as settled fact. Rendered here rather
          than only in the notice at the bottom, because this line is the one a
          merchant reads. */}
      {unresolved ? (
        <p className="mt-2 text-fine text-danger">
          A change to {shortAddress(unresolved.attempted)} was submitted and is unconfirmed, so this
          may no longer be current. Check the transaction below.
        </p>
      ) : null}
      <p className="mt-auto pt-4.5 text-meta text-muted">
        Set on-chain at registration. The contract gates the change on the current payout, so
        nobody else can point your takings somewhere new — including us.
      </p>
      <a
        className="focus-ring mt-3 w-fit rounded-badge text-body"
        href={basescanAddress(shown)}
        target="_blank"
        rel="noreferrer"
      >
        View on Basescan ↗
      </a>

      {editing ? (
        <div className="mt-4 border-t border-hairline pt-4">
          {isPayout ? (
            <>
              <label className="flex flex-col gap-1.75">
                <span className="text-key font-medium">New payout address</span>
                <Input
                  value={next}
                  onChange={(event) => setNext(event.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-mono"
                />
              </label>
              {/* The rule that makes a typo unrecoverable, said before the
                  transaction rather than after it: the new address becomes the
                  only one that can rotate again. */}
              <p className="mt-2 text-fine text-faint">
                Check it character by character. Once this lands, only the new address can change
                it again — a valid address you do not control cannot be undone by anyone.
              </p>
              <div className="mt-3.5 flex gap-2.5">
                <Button size="sm" onClick={() => void submit()} disabled={busy || next.trim() === ""}>
                  {busy ? "Confirming…" : "Change payout address"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                    setNext("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-meta text-muted">
                {signer === null
                  ? "Connect the wallet that receives this shop's payouts. The contract accepts this change from that address and no other, so there is nothing for us to verify."
                  : `You are connected as ${shortAddress(signer)}, which is not this shop's payout address. Switch to ${shortAddress(merchant.payout)} to make this change.`}
              </p>
              <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
                <ConnectButton showBalance={false} chainStatus="none" />
                <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </>
          )}
          {error ? <p className="mt-3 text-meta text-danger break-words">{error}</p> : null}
        </div>
      ) : (
        <Button variant="secondary" size="sm" className="mt-4 w-fit" onClick={() => setEditing(true)}>
          Change payout address
        </Button>
      )}

      {unresolved ? (
        <Card tone="sunken" radius="control-m" pad="none" className="mt-3.5 px-4.5 py-4">
          <p className="text-meta-sm text-muted break-words">{unresolved.text}</p>
          <a
            href={basescanTx(unresolved.txHash)}
            target="_blank"
            rel="noreferrer"
            className="focus-ring mt-2.5 inline-block rounded-badge text-meta text-accent underline-offset-2 hover:underline"
          >
            Check {shortAddress(unresolved.txHash)} on Basescan
          </a>
        </Card>
      ) : null}
    </Card>
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
