import { PayerApp } from "@/components/payer/payer-app";

/** A shop's public page, shareable on its own URL — the same screen a receipt's
 * "About this shop" opens, so a link someone sends and a link someone taps land
 * in exactly one place. */
export default async function MerchantPublicPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return <PayerApp initialOverlay={{ kind: "merchant", handle: handle.toLowerCase() }} />;
}
