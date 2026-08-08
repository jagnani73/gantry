"use client";

import { useState } from "react";
import Link from "next/link";
import { formatUnits6, shortAddress } from "@gantry/shared";
import { Card, Chip, Figure, Label, Money, Mono, StatusDot } from "@/components/primitives";
import { api } from "@/lib/api";
import { ActivityRowItem } from "./activity-row";
import { placesPaid } from "./activity";
import { formatRate, sgdUnits } from "./format";
import { MerchantTile } from "./merchant-tile";
import { usePayer } from "./payer-context";

/**
 * The payer's home: what they can spend, the way in, and where their money has
 * been going.
 *
 * "Places you've paid" is derived from their own settlement history and nothing
 * else — there is no merchant directory in this product, so a shop appears here
 * only because they have actually paid it.
 */
export function WalletScreen() {
  const {
    identity,
    balance,
    rate,
    settlements,
    rows,
    merchant,
    refreshBalance,
    pushOverlay,
  } = usePayer();
  const [toppingUp, setToppingUp] = useState(false);
  const [topUpError, setTopUpError] = useState<string | null>(null);

  const places = placesPaid(rows).slice(0, 4);
  const recent = rows.slice(0, 3);
  // Nothing will ever load without a payer address, so "loading…" would spin
  // forever. This only happens with the demo off and no wallet connected.
  const noWallet = identity.ready && !identity.address;

  const topUp = async () => {
    if (!identity.address) return;
    setTopUpError(null);
    setToppingUp(true);
    try {
      await api.faucet(identity.address);
      refreshBalance();
    } catch (err) {
      setTopUpError(err instanceof Error ? err.message : String(err));
    } finally {
      setToppingUp(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-screen-title">Wallet</h1>
        {identity.address ? (
          <span className="flex items-center gap-1.75 rounded-control bg-surface px-2.75 py-1.5">
            <StatusDot tone="accent" />
            <Mono size="2xs" tone="quiet">
              {shortAddress(identity.address)}
            </Mono>
          </span>
        ) : null}
      </div>

      <Card tone="accent" radius="panel" pad="md" className="mt-4.5">
        <Label tone="on-accent-muted">Available to spend</Label>
        {balance === null ? (
          <Figure value="—" size="balance" tone="on-accent" className="mt-3" />
        ) : rate ? (
          <Figure units={sgdUnits(balance, rate)} size="balance" tone="on-accent" className="mt-3" />
        ) : (
          <Figure
            units={balance}
            dp={2}
            prefix={null}
            suffix="USDC"
            size="balance"
            tone="on-accent"
            className="mt-3"
          />
        )}
        <div className="mt-3 flex items-center justify-between gap-3">
          <Mono size="sm" className="text-on-accent-muted">
            {balance !== null
              ? `${formatUnits6(balance, 6)} USDC`
              : noWallet
                ? "no wallet"
                : "reading balance…"}
          </Mono>
          {identity.demo ? (
            <button
              type="button"
              disabled={toppingUp || !identity.address}
              onClick={() => void topUp()}
              className="focus-ring-inverse shrink-0 rounded-control bg-on-accent/14 px-3.5 py-1.75 text-meta font-medium text-on-accent transition-colors hover:bg-on-accent/22 disabled:text-on-accent-muted"
            >
              {toppingUp ? "Topping up…" : "Top up"}
            </button>
          ) : null}
        </div>
        {/* The S$ figure is a conversion, not a price: one address sets this rate
            on FixedRateSwap and nothing arbitrages it. */}
        {rate ? (
          <p className="mt-2.5 text-fine text-on-accent-muted">
            at the demo rate · 1 USDC = {formatRate(rate)} XSGD, set by the swap&apos;s owner
          </p>
        ) : null}
      </Card>

      {topUpError ? (
        <Card tone="danger" radius="control-m" pad="none" className="mt-2.5 px-4 py-3.5">
          <p className="text-meta-sm break-words">{topUpError}</p>
        </Card>
      ) : null}

      {identity.demo ? (
        <Card tone="sunken" radius="control-m" pad="none" className="mt-2.5 flex gap-3 px-4 py-3.5">
          <Chip tone="accent" size="sm" mono className="shrink-0 self-start">
            DEMO
          </Chip>
          <p className="text-meta-sm text-muted">
            A shared demo wallet, funded for you. Anyone using this demo signs with the same
            account, so this history is not private.
          </p>
        </Card>
      ) : null}

      <button
        type="button"
        onClick={() => pushOverlay({ kind: "scan" })}
        className="focus-ring mt-4.5 flex h-14 w-full items-center justify-center gap-2.5 rounded-card bg-ink text-btn text-paper transition-colors hover:bg-ink-hover"
      >
        <span className="size-3.5 rounded-xs border-2 border-paper" aria-hidden />
        Scan to pay
      </button>

      <div className="mt-6.5 flex items-baseline justify-between gap-3">
        <h2 className="text-card-title-sm">Recent</h2>
        <Link href="/app/activity" className="focus-ring rounded-badge text-meta text-accent">
          All activity →
        </Link>
      </div>
      <Card radius="card" pad="none" className="mt-2.5 px-4 py-1.5">
        {noWallet ? (
          <p className="py-4 text-body-sm text-muted">
            Connect a wallet in Settings to see your payments.
          </p>
        ) : settlements === null ? (
          <p className="py-4 text-body-sm text-muted">Loading your payments…</p>
        ) : recent.length === 0 ? (
          <p className="py-4 text-body-sm text-muted">
            Nothing yet. Scan a shop&apos;s code and the payment lands here the moment it settles.
          </p>
        ) : (
          recent.map((row) => <ActivityRowItem key={row.key} row={row} />)
        )}
      </Card>

      {places.length > 0 ? (
        <>
          <h2 className="mt-6.5 text-card-title-sm">Places you&apos;ve paid</h2>
          <div className="mt-2.5 flex flex-col gap-2">
            {places.map((place) => {
              const record = merchant(place.handle);
              const name = record?.displayName ?? place.handle;
              return (
                <button
                  key={place.handle}
                  type="button"
                  onClick={() => pushOverlay({ kind: "merchant", handle: place.handle })}
                  className="focus-ring flex items-center gap-3 rounded-control-m bg-surface px-4 py-3.5 text-left transition-colors hover:bg-fill-hover-card"
                >
                  <MerchantTile name={name} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-row-title">{name}</span>
                    <span className="mt-0.5 block truncate text-fine text-faint">
                      {place.payments} {place.payments === 1 ? "payment" : "payments"} ·{" "}
                      <Money units={place.total} prefix="S$" size="xs" tone="faint" className="text-fine" />
                    </span>
                  </span>
                  <span className="text-body-sm text-hint" aria-hidden>
                    ›
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      <div className="h-3" />
    </>
  );
}
