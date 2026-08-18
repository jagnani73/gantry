import { resolveScope } from "@gantry/shared";
import { QrScreen } from "@/components/merchant/qr-screen";
import { qrMatrix } from "@/components/merchant/qr-matrix";
import { appUrl, backendUrl } from "@/lib/env";

/**
 * The standee's matrix is computed on the server so the QR library never reaches
 * a browser bundle — that code depends only on the handle and the app's own
 * origin, neither of which the client knows better than we do.
 *
 * The charge link's code cannot be: its amount is typed. That one is built in
 * the browser from a dynamic import, so the library still stays out of the
 * initial bundle. It also points at the BACKEND rather than at this app, because
 * only the backend can answer a machine with a priced 402.
 */
export default async function MerchantQrPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle: raw } = await params;
  const handle = resolveScope(raw) ?? raw;
  const payUrl = `${appUrl()}/pay/${handle}`;
  return <QrScreen payUrl={payUrl} qr={qrMatrix(payUrl)} backendOrigin={backendUrl()} />;
}
