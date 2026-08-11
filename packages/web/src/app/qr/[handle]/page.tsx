import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveScope } from "@gantry/shared";
import { Card } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { PrintButton } from "@/components/print-button";
import { qrMatrix } from "@/components/merchant/qr-matrix";
import { Standee } from "@/components/merchant/standee";
import { DEFAULT_SCREEN, merchantHref } from "@/components/merchant/screens";
import { ApiClientError, api } from "@/lib/api";
import { appUrl } from "@/lib/env";

/**
 * The standee on its own page — nothing but the sheet and two buttons that do
 * not print.
 *
 * The shop's name is fetched here rather than passed in, and the two ways that
 * can fail are NOT the same, because this page's output gets laminated:
 *
 *  - **The handle is not registered.** `notFound()`. A printable sheet for a
 *    shop that does not exist is the worst thing this route can produce: the QR
 *    is valid, the tagline is confident, and every payer who scans it reaches a
 *    pay page that cannot take money. One transposed letter in the URL is enough
 *    to produce it, and nothing on the sheet would say so.
 *  - **The lookup failed.** Fall back to the handle and print. A cold backend
 *    must cost the standee its display name, never the sheet itself — the code
 *    depends on nothing but the handle. This is the common case on a venue
 *    hotspot, and on the deployed build after a free-tier spin-down.
 *
 * The rest of the app already draws this line (`merchant-context.tsx`,
 * `payer-context.tsx`, `scan.tsx`, `pay-flow.tsx` all branch on
 * `MerchantNotFound` by name); this route was the one surface that collapsed
 * them, and the only one whose mistakes are physical.
 *
 * It deliberately does NOT fall back to `DEMO_MERCHANTS`. The display record
 * lives in GantryCore now, and a seed constant is a name no screen in the app
 * would agree with — so a laminated standee could carry a shop name that the
 * payer page, the receipt and the merchant's own back-office all deny.
 */
export default async function QrPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  const handle = resolveScope(raw) ?? raw;
  const payUrl = `${appUrl()}/pay/${handle}`;

  let name = handle;
  let location: string | undefined;
  let unconfirmed = false;
  try {
    const merchant = await api.merchant(handle);
    name = merchant.displayName ?? name;
    location = merchant.location ?? location;
  } catch (err) {
    if (err instanceof ApiClientError && err.errorName === "MerchantNotFound") notFound();
    // Logged, not swallowed: this is a server component, so it costs one line in
    // the dev or Vercel log, and without it a timeout and a captive portal are
    // indistinguishable from a shop that simply has no display name.
    console.error(`[qr] merchant lookup failed for ${handle}:`, err);
    unconfirmed = true;
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 p-6">
      <Card radius="card" pad="lg" className="w-full max-w-sm print:p-0">
        <Standee name={name} location={location} payUrl={payUrl} qr={qrMatrix(payUrl)} />
      </Card>
      {unconfirmed ? (
        // On screen only. The sheet is still correct to print — the QR encodes
        // the handle and nothing else — but whoever prints it should know the
        // name was never confirmed, rather than reading the handle as the shop's
        // chosen name.
        <p className="no-print max-w-sm text-center text-meta text-muted">
          Couldn&apos;t reach the backend, so this shows the handle rather than the shop&apos;s
          name. The QR itself is correct and will take payments.
        </p>
      ) : null}
      <div className="no-print flex gap-2">
        <Button asChild variant="secondary">
          <Link href={merchantHref(handle, DEFAULT_SCREEN)}>Back to the back-office</Link>
        </Button>
        <PrintButton />
      </div>
    </main>
  );
}
