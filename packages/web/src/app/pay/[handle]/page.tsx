import { PayerApp } from "@/components/payer/payer-app";

/**
 * What the printed QR opens.
 *
 * It lands directly in the amount screen for that shop — a stranger pointing a
 * phone at a standee should be typing a price, not reading a home screen — and
 * the payer app's wallet tab sits behind it so dismissing the payment leaves
 * them somewhere real. Handles are lowercase on-chain; a scanner that
 * upper-cased one must still find the shop.
 *
 * `?sgd=` is the shop's asking price, and it arrives two ways: from a merchant's
 * charge link, or from the backend's own `/pay/:handle` redirect — the dual-door
 * URL, which answers a machine with an HTTP 402 for this same amount and a
 * browser with this page. It only ever PREFILLS the pad. The standee carries no
 * amount and must not start carrying one: a printed code that names a price is a
 * code that has to be reprinted.
 */
export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ sgd?: string | string[] }>;
}) {
  const { handle } = await params;
  const { sgd } = await searchParams;
  // A repeated `?sgd=1&sgd=2` arrives as an array. Ignore it rather than picking
  // one — two prices in a link is a broken link, and guessing which the shop
  // meant is the wrong kind of helpful on a screen someone signs from.
  const amount = typeof sgd === "string" ? sgd : undefined;
  return <PayerApp initialOverlay={{ kind: "pay", handle: handle.toLowerCase(), amount }} />;
}
