import Link from "next/link";
import { resolveScope } from "@gantry/shared";
import { Card } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { PrintButton } from "@/components/print-button";
import { qrMatrix } from "@/components/merchant/qr-matrix";
import { Standee } from "@/components/merchant/standee";
import { DEFAULT_SCREEN, merchantHref } from "@/components/merchant/screens";
import { api } from "@/lib/api";
import { appUrl } from "@/lib/env";

/**
 * The standee on its own page — nothing but the sheet and two buttons that do
 * not print.
 *
 * The shop's name is fetched here rather than passed in, and a failed fetch
 * falls back to the handle. This page exists to be printed, often from a laptop
 * on a venue hotspot: a cold backend must cost the standee its display name,
 * never the code itself, which depends on nothing but the handle.
 *
 * It deliberately does NOT fall back to `DEMO_MERCHANTS`. The display record
 * lives in GantryCore now, and a seed constant is a name no screen in the app
 * would agree with — so a laminated standee could carry a shop name that the
 * payer page, the receipt and the merchant's own back-office all deny. The
 * handle is the honest degradation, because it is the one thing the printed QR
 * itself encodes.
 */
export default async function QrPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  const handle = resolveScope(raw) ?? raw;
  const payUrl = `${appUrl()}/pay/${handle}`;

  let name = handle;
  let location: string | undefined;
  try {
    const merchant = await api.merchant(handle);
    name = merchant.displayName ?? name;
    location = merchant.location ?? location;
  } catch {
    // Keep the fallback. A standee that says the handle is still a standee that
    // takes payments; one that fails to render is not.
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 p-6">
      <Card radius="card" pad="lg" className="w-full max-w-sm print:p-0">
        <Standee name={name} location={location} payUrl={payUrl} qr={qrMatrix(payUrl)} />
      </Card>
      <div className="no-print flex gap-2">
        <Button asChild variant="secondary">
          <Link href={merchantHref(handle, DEFAULT_SCREEN)}>Back to the back-office</Link>
        </Button>
        <PrintButton />
      </div>
    </main>
  );
}
