"use client";

import { useEffect, useState } from "react";
import { Card, Label, Mono } from "@/components/primitives";
import { cn } from "@/lib/utils";
// The payer's own rule, imported rather than restated. An amount this accepts
// but the pay pad does not would produce a link that silently refuses to
// prefill — the merchant would see a QR, the customer an empty keypad, and
// nothing would report an error.
import { isAmountShape } from "@/components/payer/amount-keypad";
import { QR_QUIET_ZONE, type QrMatrix } from "./qr-matrix";

type CopyState = "idle" | "copied" | "failed";

/**
 * One sale, one link — and the link is the thesis.
 *
 * `<backend>/pay/:handle?sgd=4.50` answers a browser with the payer page and a
 * machine with an HTTP 402 for the same amount, priced by the same function and
 * settled by the same contract call. So the shop shows one code and does not
 * need to know whether the customer is a person or a piece of software.
 *
 * It points at the BACKEND, not the payer app: the 402 can only come from the
 * server that holds the rate, the registry and the pin secret. The browser half
 * is a redirect back to the payer app.
 *
 * This is NOT the standee, and the two must not merge. The standee names a shop
 * and never a price, which is why one printed sheet lasts forever; this names a
 * price, so it lives on a screen and lasts one sale. A 402 challenge has to
 * carry an amount, so an amount-less link can never be the machine door — that
 * is the whole reason this card exists.
 *
 * The QR is built in the browser here, unlike the standee's server-rendered
 * one, because the amount is typed. The library loads on demand (the same
 * `await import` the PNG download already uses) so it stays out of the initial
 * bundle for a screen most merchants open once.
 */
export function ChargeCard({ handle, backendOrigin }: { handle: string; backendOrigin: string }) {
  const [amount, setAmount] = useState("");
  const [qr, setQr] = useState<QrMatrix | null>(null);
  const [copied, setCopied] = useState<CopyState>("idle");

  const valid = isAmountShape(amount);
  const link = valid ? `${backendOrigin}/pay/${handle}?sgd=${amount}` : "";

  useEffect(() => {
    if (!link) {
      setQr(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { qrMatrix } = await import("./qr-matrix");
      // The amount can change while the import resolves; a late write would
      // paint a code for a price the merchant has already edited away.
      if (!cancelled) setQr(qrMatrix(link));
    })();
    return () => {
      cancelled = true;
    };
  }, [link]);

  useEffect(() => setCopied("idle"), [link]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("copied");
    } catch {
      // No clipboard API outside a secure context — a tablet on the venue
      // network hitting the laptop over http has none. Say so; the link is on
      // screen to select by hand.
      setCopied("failed");
    }
  }

  const span = qr ? qr.size + QR_QUIET_ZONE * 2 : 0;

  return (
    <Card radius="card" pad="md">
      <div className="text-card-title-sm">Charge an amount</div>
      <p className="mt-2 mb-4 text-body text-muted">
        A link for one sale. Show the code, or send the link — whoever is paying, the money
        lands the same way.
      </p>

      <label className="block">
        <Label>Amount</Label>
        <div className="mt-1.5 flex items-center gap-2.5 rounded-control bg-fill-hover px-3.5">
          <span className="text-body-lg text-faint">S$</span>
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="4.50"
            aria-label="Amount in Singapore dollars"
            aria-invalid={amount !== "" && !valid}
            className="focus-ring text-body-lg w-full bg-transparent py-2.75 text-ink placeholder:text-faint"
          />
        </div>
      </label>

      {amount !== "" && !valid ? (
        <p className="mt-2 text-fine text-danger">
          Up to two decimals and under S$10,000 — the same amounts the payer&apos;s keypad
          accepts.
        </p>
      ) : null}

      {valid ? (
        <div className="mt-4.5">
          <div className="flex items-start gap-4.5">
            {/* Deliberately not the Standee's SVG reused: that component renders
                the printed sheet, and this screen is not worth the risk of
                touching it. The geometry is the same nine lines. */}
            <svg
              role="img"
              aria-label={`QR code for ${link}`}
              viewBox={`${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${span} ${span}`}
              shapeRendering="crispEdges"
              className={cn("block h-40 w-40 shrink-0 rounded-control", qr ? "" : "opacity-0")}
            >
              {qr ? (
                <>
                  <rect
                    x={-QR_QUIET_ZONE}
                    y={-QR_QUIET_ZONE}
                    width={span}
                    height={span}
                    className="fill-surface"
                  />
                  <path d={qr.path} className="fill-ink" />
                </>
              ) : null}
            </svg>

            <div className="min-w-0 flex-1">
              <Label>The link</Label>
              <div className="mt-1.5 flex items-center justify-between gap-3 rounded-control bg-fill-hover px-3.5 py-3">
                <Mono size="md" tone="quiet" className="min-w-0 break-all">
                  {link}
                </Mono>
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="focus-ring shrink-0 rounded-badge text-meta text-accent hover:text-accent-hover"
                >
                  {copied === "copied" ? "Copied" : copied === "failed" ? "Select it" : "Copy"}
                </button>
              </div>
              <p className="mt-3.5 text-meta text-faint">
                Open it on a phone and it is the payment page for S${amount}. Fetch it as a
                machine and it answers <Mono size="sm">402 Payment Required</Mono> for the same
                S${amount}. One link, both doors, one settlement.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
