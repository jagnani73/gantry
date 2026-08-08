import { Label, Mono } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { QR_QUIET_ZONE, type QrMatrix } from "./qr-matrix";

/**
 * The thing that goes on the counter.
 *
 * The code encodes the shop's HANDLE, never an amount, which is why one printed
 * sheet lasts forever and why the same URL is what an agent hits over x402. The
 * matrix arrives already computed so this component can render on either side of
 * the client boundary without pulling the QR library into a browser bundle.
 */
export function Standee({
  name,
  location,
  payUrl,
  qr,
  className,
}: {
  name: string;
  location?: string;
  payUrl: string;
  qr: QrMatrix;
  className?: string;
}) {
  const span = qr.size + QR_QUIET_ZONE * 2;
  return (
    <div className={cn("rounded-tile border border-nav-active p-7 text-center", className)}>
      <Label size="wide">Scan to pay</Label>
      <div className="mt-2 mb-4.5 text-title-sm">{name}</div>
      <svg
        role="img"
        aria-label={`QR code for ${payUrl}`}
        viewBox={`${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${span} ${span}`}
        shapeRendering="crispEdges"
        className="mx-auto block h-auto w-full"
      >
        <rect
          x={-QR_QUIET_ZONE}
          y={-QR_QUIET_ZONE}
          width={span}
          height={span}
          className="fill-surface"
        />
        <path d={qr.path} className="fill-ink" />
      </svg>
      <div className="mt-4.5 text-meta text-quiet">Any wallet · no gas · settles in XSGD</div>
      {location ? <div className="mt-1 text-fine text-faint">{location}</div> : null}
      <Mono size="4xs" tone="faint" className="mt-3 block break-all">
        {payUrl}
      </Mono>
    </div>
  );
}
