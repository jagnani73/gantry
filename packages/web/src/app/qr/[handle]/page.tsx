import QRCode from "qrcode";
import Link from "next/link";
import { DEMO_MERCHANTS } from "@gantry/shared";
import { appUrl } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { PrintButton } from "@/components/print-button";

export default async function QrPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const payUrl = `${appUrl()}/pay/${handle}`;
  const svg = await QRCode.toString(payUrl, { type: "svg", margin: 1, width: 480 });
  const demo = DEMO_MERCHANTS[handle];

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
      <div className="w-full max-w-sm rounded-2xl border-2 border-foreground p-8 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
          Scan to pay
        </p>
        <h1 className="mb-4 mt-1 text-2xl font-bold">{demo?.displayName ?? handle}</h1>
        {/* Safe: the SVG is qrcode-library geometry only — the handle is encoded
            into QR modules, never interpolated into markup. */}
        <div
          className="mx-auto w-full [&_svg]:h-auto [&_svg]:w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <p className="mt-4 text-sm text-muted-foreground">
          Any wallet · no gas needed · settles in XSGD
        </p>
        {demo?.location && <p className="mt-1 text-xs text-muted-foreground">{demo.location}</p>}
        <p className="mt-3 break-all font-mono text-[10px] text-muted-foreground">{payUrl}</p>
      </div>
      <div className="no-print flex gap-2">
        <Button asChild variant="outline">
          <Link href={`/pay/${handle}`}>Open payer page</Link>
        </Button>
        <PrintButton />
      </div>
    </main>
  );
}
