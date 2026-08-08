import { resolveScope } from "@gantry/shared";
import { QrScreen } from "@/components/merchant/qr-screen";
import { qrMatrix } from "@/components/merchant/qr-matrix";
import { appUrl } from "@/lib/env";

/**
 * The matrix is computed on the server so the QR library never reaches a browser
 * bundle — the code depends only on the handle and the app's own origin, neither
 * of which the client knows better than we do.
 */
export default async function MerchantQrPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle: raw } = await params;
  const handle = resolveScope(raw) ?? raw;
  const payUrl = `${appUrl()}/pay/${handle}`;
  return <QrScreen payUrl={payUrl} qr={qrMatrix(payUrl)} />;
}
