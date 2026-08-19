"use client";

import { useState } from "react";
import { Card, Mono } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { ChargeCard } from "./charge-card";
import { useMerchantContext, shopName } from "./merchant-context";
import type { QrMatrix } from "./qr-matrix";
import { ScreenHeader } from "./screen-header";
import { Standee } from "./standee";

type CopyState = "idle" | "copied" | "failed";

export function QrScreen({
  payUrl,
  qr,
  backendOrigin,
}: {
  payUrl: string;
  qr: QrMatrix;
  backendOrigin: string;
}) {
  const { handle, merchant } = useMerchantContext();
  const [copied, setCopied] = useState<CopyState>("idle");
  const [downloading, setDownloading] = useState(false);
  /** A failed PNG export. Without this a chunk that will not load left an
   * unhandled rejection and a button that merely stopped spinning — the
   * merchant taps it again, and again, with nothing to read. */
  const [downloadFailed, setDownloadFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(payUrl);
      setCopied("copied");
    } catch {
      // Non-secure contexts (a phone hitting the laptop over http on the venue
      // network) have no clipboard API at all. Say so — the URL is right there
      // to select by hand.
      setCopied("failed");
    }
  }

  async function downloadPng() {
    setDownloading(true);
    setDownloadFailed(false);
    try {
      // Loaded on demand: the QR on screen is server-rendered geometry, so the
      // library is only needed by the one button that wants a raster file.
      const { toDataURL } = await import("qrcode");
      const url = await toDataURL(payUrl, { width: 1024, margin: 2 });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `gantry-${handle}-qr.png`;
      anchor.click();
    } catch (err) {
      // The library loads on demand, so this is a network or stale-chunk
      // failure rather than a bad input. The printed code on screen is
      // unaffected and remains the thing the merchant actually needs.
      console.warn("gantry: QR PNG export failed", err);
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <ScreenHeader title="QR & standee" className="print:hidden">
        One printed code. Anyone scans it: no app, no account, no gas.
      </ScreenHeader>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[420px_1fr]">
        <Card radius="card" pad="lg" className="print:p-0">
          <Standee
            name={shopName(merchant, handle)}
            location={merchant?.location}
            payUrl={payUrl}
            qr={qr}
          />
        </Card>

        <div className="flex flex-col gap-3.5 print:hidden">
          <Card radius="card" pad="md">
            <div className="text-card-title-sm">Print it</div>
            <p className="mt-2 mb-4 text-body text-muted">
              The code never expires and never needs replacing: it points at your handle, not at
              an amount. Printing hides everything on this page except the standee.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => window.print()}>
                Print standee
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void downloadPng()}
                disabled={downloading}
              >
                {downloading ? "Preparing…" : downloadFailed ? "Try again" : "Download PNG"}
              </Button>
            </div>
            {downloadFailed ? (
              <p className="mt-3 text-meta text-danger">
                The image could not be generated on this device. Printing this page still works —
                it is the same code.
              </p>
            ) : null}
          </Card>

          <Card radius="card" pad="md">
            <div className="text-card-title-sm">Your pay link</div>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-control bg-fill-hover px-3.5 py-3">
              <Mono size="md" tone="quiet" className="min-w-0 break-all">
                {payUrl}
              </Mono>
              <button
                type="button"
                onClick={() => void copy()}
                className="focus-ring shrink-0 rounded-badge text-meta text-accent hover:text-accent-hover"
              >
                {copied === "copied" ? "Copied" : copied === "failed" ? "Select it" : "Copy"}
              </button>
            </div>
            {/* This used to claim "the same link an AI agent hits over x402".
                It is not: this link names a shop and no amount, and an x402
                challenge has to carry a price, so an amount-less link can never
                be the machine door. The dual-door link is the charge link
                below, which is why that card exists. */}
            <p className="mt-3.5 text-meta text-faint">
              Names your shop, never a price — so it never needs reprinting. For a machine to
              pay, an amount has to be in the link: use Charge an amount.
            </p>
          </Card>

          <ChargeCard handle={handle} backendOrigin={backendOrigin} />
        </div>
      </div>
    </>
  );
}
