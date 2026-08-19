"use client";

import { useEffect, useState } from "react";
import {
  PAYMENT_REQUIRED_HEADER,
  decodePaymentRequiredHeader,
  formatUnits6,
  shortAddress,
  type X402PaymentRequired,
} from "@gantry/shared";
import { Card, Label, Mono } from "@/components/primitives";
import { backendUrl } from "@/lib/env";

/**
 * The other door, shown to a human.
 *
 * Every shop on this rail is also an HTTP endpoint an AI agent can pay, and
 * until now that was only provable from a terminal — so the half of the product
 * that nothing else in the field has was invisible to anyone browsing the site.
 * This asks the live payment server for a real bill and renders what came back.
 *
 * It FETCHES rather than illustrates, and the difference is the entire point: a
 * screenshot of a 402 is a claim, and a 402 with this minute's price in it is
 * evidence. That also means it can fail, so it says which it is showing —
 * "asked just now" against a decoded challenge, or the command alone when the
 * server did not answer. It never renders an invented challenge.
 *
 * Read-only by construction: this is the unpaid half of the exchange. Nothing
 * here signs, holds a key, or costs anyone a cent — which is why it can sit on a
 * public page, and why it is the cheap version of putting an agent on the site.
 */

/** A sample bill. The endpoint prices whatever it is asked for; a shop page has
 * no amount of its own, so one is chosen and labelled as chosen. */
const SAMPLE_SGD = "4.50";

type Probe =
  | { state: "loading" }
  | { state: "live"; challenge: X402PaymentRequired }
  | { state: "unreachable"; why: string };

export function MachineDoor({ handle }: { handle: string }) {
  const [probe, setProbe] = useState<Probe>({ state: "loading" });
  const url = `${backendUrl()}/pay/${handle}?sgd=${SAMPLE_SGD}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // `Accept: application/json` is what makes this the MACHINE door: the
        // same URL answers a browser's `text/html` with a redirect to the payer
        // app, so asking as a browser here would follow it and prove nothing.
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        const header = res.headers.get(PAYMENT_REQUIRED_HEADER);
        if (res.status !== 402 || !header) {
          // A missing header on a 402 is the CORS case: the challenge is in a
          // custom header, which a browser cannot read unless the server exposes
          // it. Worth naming rather than calling the server unreachable.
          throw new Error(
            res.status === 402
              ? "the server answered 402 but this page could not read the challenge header"
              : `expected 402, got ${res.status}`,
          );
        }
        if (!cancelled) setProbe({ state: "live", challenge: decodePaymentRequiredHeader(header) });
      } catch (err) {
        if (!cancelled) {
          setProbe({ state: "unreachable", why: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <Card radius="card-m" pad="md">
      <div className="text-card-title-xs">Machines can pay this shop</div>
      <p className="mt-2 text-body-sm text-quiet">
        The same link you would open on a phone answers an AI agent with a bill it can settle
        itself — same shop, same price, same contract. Here is that bill for a sample S$
        {SAMPLE_SGD} order.
      </p>

      <div className="mt-4">
        <Label>Ask for it yourself</Label>
        {/* Wide, and must scroll inside its own box rather than widening the
            page — this frame is phone-shaped. */}
        <div className="mt-1.5 overflow-x-auto rounded-control bg-fill-hover px-3.5 py-3">
          <Mono size="md" tone="quiet" className="whitespace-pre">
            {`curl -i -H 'Accept: application/json' \\\n  "${url}"`}
          </Mono>
        </div>
      </div>

      <div className="mt-4">
        {probe.state === "loading" ? (
          <Mono size="md" tone="faint">
            asking the payment server…
          </Mono>
        ) : probe.state === "unreachable" ? (
          <>
            <Mono size="md" tone="faint">
              The live check did not answer, so nothing is shown here rather than a made-up
              reply. The command above still works.
            </Mono>
            <Mono size="3xs" tone="faintest" className="mt-2 block break-all">
              {probe.why}
            </Mono>
          </>
        ) : (
          <Challenge challenge={probe.challenge} />
        )}
      </div>
    </Card>
  );
}

function Challenge({ challenge }: { challenge: X402PaymentRequired }) {
  return (
    <div className="rounded-control border border-fill-subtle">
      <div className="flex items-baseline justify-between gap-3 border-b border-fill-subtle px-3.5 py-2.5">
        <Mono size="md" className="text-ink">
          402 Payment Required
        </Mono>
        <span className="text-fine text-faint">asked just now</span>
      </div>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        {challenge.accepts.map((offer) => (
          <div key={offer.scheme}>
            <div className="flex items-baseline justify-between gap-3">
              <Mono size="md" className="text-ink">
                {offer.scheme}
              </Mono>
              <span className="text-fine text-faint">
                {offer.scheme === "exact"
                  ? "any standard x402 client"
                  : "through an on-chain spend policy"}
              </span>
            </div>
            {/* Six decimals, not the 2dp default: this is the exact figure a
                client signs for, and 3.352955 rounded to 3.35 is a different
                amount of someone's money on the one card whose claim is that
                these numbers are real. */}
            <Mono size="3xs" tone="faintest" className="mt-1 block">
              {formatUnits6(BigInt(offer.amount), 6)} USDC → {shortAddress(offer.payTo)} on{" "}
              {offer.network}
            </Mono>
          </div>
        ))}
      </div>
    </div>
  );
}
