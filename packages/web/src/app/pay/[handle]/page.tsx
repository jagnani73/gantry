import { PayerApp } from "@/components/payer/payer-app";

/**
 * What the printed QR opens.
 *
 * It lands directly in the amount screen for that shop — a stranger pointing a
 * phone at a standee should be typing a price, not reading a home screen — and
 * the payer app's wallet tab sits behind it so dismissing the payment leaves
 * them somewhere real. Handles are lowercase on-chain; a scanner that
 * upper-cased one must still find the shop.
 */
export default async function PayPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <PayerApp initialOverlay={{ kind: "pay", handle: handle.toLowerCase() }} />;
}
