"use client";

import { useEffect, useRef, useState } from "react";
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

/** How long "Copied" stays up. Long enough to read, short enough that the
 * button is ready again before a reader thinks to tap it twice. */
const COPY_RESET_MS = 2_000;

type CopyState = "idle" | "copied" | "failed";

type Probe =
  | { state: "loading" }
  | { state: "live"; challenge: X402PaymentRequired }
  | { state: "unreachable"; why: string };

export function MachineDoor({ handle }: { handle: string }) {
  const [probe, setProbe] = useState<Probe>({ state: "loading" });
  const [copied, setCopied] = useState<CopyState>("idle");
  const url = `${backendUrl()}/pay/${handle}?sgd=${SAMPLE_SGD}`;
  /** ONE string, shown and copied. Built separately they would drift, and the
   * copied one is the half nobody proof-reads. */
  const command = `curl -i -H 'Accept: application/json' \\\n  "${url}"`;

  /** Timer for the "Copied" label, cleared on unmount so a resolved copy cannot
   * set state on a card the reader has navigated away from. */
  const resetAt = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetAt.current), []);

  async function copyCommand() {
    clearTimeout(resetAt.current);
    try {
      await navigator.clipboard.writeText(command);
      setCopied("copied");
      /* "Copied" REVERTS, and that is the whole point of the timer: this URL
         never changes, so without it the button said "Copied" for the rest of
         the session and a second tap gave no feedback at all — the reader could
         not tell a copy that worked from a button that had stopped responding.
         (The merchant's charge card resets on the link changing, which hides the
         same bug behind an amount that is usually retyped.) */
      resetAt.current = setTimeout(() => setCopied("idle"), COPY_RESET_MS);
    } catch {
      // No clipboard API outside a secure context — a phone on the venue network
      // reaching this laptop over plain http has none. Say so; the command is on
      // screen to select by hand. Same fallback the merchant's charge link uses.
      //
      // Deliberately NOT on a timer. A confirmation is an event and is safe to
      // miss; this is a CONDITION — the clipboard is unavailable and will be on
      // the next tap too — so reverting to "Copy" would invite a tap that cannot
      // work and take the instruction off screen with it.
      setCopied("failed");
    }
  }

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
        The same link answers an AI agent with a bill it can settle itself. Same shop, same price,
        same contract. Here it is for a sample S${SAMPLE_SGD} order.
      </p>

      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <Label>Ask for it yourself</Label>
          <button
            type="button"
            onClick={() => void copyCommand()}
            className="focus-ring rounded-badge text-meta text-accent hover:text-accent-hover"
          >
            {copied === "copied" ? "Copied" : copied === "failed" ? "Select it" : "Copy"}
          </button>
        </div>
        {/* Wide, and must scroll inside its own box rather than widening the
            page — this frame is phone-shaped. Which is also why the copy button
            exists: the command runs off the right edge on a handset, so the one
            thing this card invites a reader to do was the one thing they could
            not do without horizontal-scrolling a code block and selecting it by
            hand. */}
        <div className="mt-1.5 overflow-x-auto rounded-control bg-fill-hover px-3.5 py-3">
          <Mono size="md" tone="quiet" className="whitespace-pre">
            {command}
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

/**
 * The ticker for one offer, taken from the challenge rather than assumed.
 *
 * `extra.name` is the EIP-712 token name the server published — the same key the
 * agent and `x402:buy` select on — so this card names what the server named.
 * Null when it is absent: this card's whole claim is that it shows you the real
 * response, so a missing ticker prints no ticker rather than a plausible one.
 */
function tokenLabel(offer: X402PaymentRequired["accepts"][number]): string | null {
  const name = offer.extra?.["name"];
  return typeof name === "string" && name ? name : null;
}

/**
 * Offers grouped by scheme, in the order the server sent them.
 *
 * CONSECUTIVE grouping, never a sort or a keyed bucket: `accepts[0]` is what a
 * vanilla x402 client takes, so the order carries meaning and reordering it here
 * would misrepresent the response this card's whole claim is that it shows you
 * verbatim. A server that ever interleaved two schemes would produce two groups
 * for one scheme, which is the honest rendering of an interleaved list.
 */
function bySchemeInOrder(accepts: X402PaymentRequired["accepts"]) {
  const groups: { scheme: string; payTo: string; offers: typeof accepts }[] = [];
  for (const offer of accepts) {
    const last = groups[groups.length - 1];
    // payTo is a property of the scheme here — `exact` collects to the relayer
    // for the custodial hop, `gantry-pbm` pays the core directly — so it lifts
    // to the group rather than repeating on every currency row.
    if (last && last.scheme === offer.scheme && last.payTo === offer.payTo) last.offers.push(offer);
    else groups.push({ scheme: offer.scheme, payTo: offer.payTo, offers: [offer] });
  }
  return groups;
}

const SCHEME_NOTE: Record<string, string> = {
  exact: "any standard x402 client",
  "gantry-pbm": "through an on-chain spend policy",
};

function Challenge({ challenge }: { challenge: X402PaymentRequired }) {
  const groups = bySchemeInOrder(challenge.accepts);
  // One line if they agree, which they always do today — a challenge names one
  // chain. Derived rather than assumed so a mixed response could not be
  // flattened into a claim the server did not make.
  const networks = [...new Set(challenge.accepts.map((offer) => offer.network))];

  return (
    <div className="rounded-control border border-fill-subtle">
      <div className="flex items-baseline justify-between gap-3 border-b border-fill-subtle px-3.5 py-2.5">
        <Mono size="md" className="text-ink">
          402 Payment Required
        </Mono>
        <span className="text-fine text-faint">asked just now</span>
      </div>

      {groups.map((group, index) => (
        <div
          key={`${group.scheme}/${group.payTo}/${index}`}
          className={index > 0 ? "border-t border-fill-subtle" : ""}
        >
          <div className="flex items-baseline justify-between gap-3 px-3.5 pt-2.5">
            <Mono size="md" className="text-ink">
              {group.scheme}
            </Mono>
            <span className="text-fine text-faint">{SCHEME_NOTE[group.scheme] ?? "custom scheme"}</span>
          </div>

          {/* A real column rather than a sentence per offer. The currencies of one
              scheme differ only in ticker and amount, so repeating "→ payTo on
              network" under each was four copies of one fact and made two numbers
              a reader wants to compare impossible to compare. `tabular-nums`
              keeps the digits on a shared grid. */}
          <div className="mt-1.5 px-3.5">
            {group.offers.map((offer) => (
              <div
                key={tokenLabel(offer) ?? offer.asset}
                className="flex items-baseline justify-between gap-3 py-0.75"
              >
                <Mono size="sm" tone="quiet">
                  {tokenLabel(offer) ?? shortAddress(offer.asset)}
                </Mono>
                {/* Six decimals, not the 2dp default: this is the exact figure a
                    client signs for, and 3.352955 rounded to 3.35 is a different
                    amount of someone's money on the one card whose claim is that
                    these numbers are real. */}
                <Mono size="sm" tone="quiet" className="tabular-nums">
                  {formatUnits6(BigInt(offer.amount), 6)}
                </Mono>
              </div>
            ))}
          </div>

          <Mono size="3xs" tone="faintest" className="mt-1 block px-3.5 pb-2.5">
            → {shortAddress(group.payTo)}
          </Mono>
        </div>
      ))}

      <div className="border-t border-fill-subtle px-3.5 py-2">
        <Mono size="3xs" tone="faintest">
          {networks.join(" · ")}
        </Mono>
      </div>
    </div>
  );
}
