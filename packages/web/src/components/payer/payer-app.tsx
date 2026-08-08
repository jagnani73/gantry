"use client";

import { PayerFrame } from "./payer-frame";
import { PayerProvider, type Overlay } from "./payer-context";
import { WalletScreen } from "./screen-wallet";

/**
 * The payer app entered from outside its own tabs — a printed QR (`/pay/…`) or a
 * shared merchant link (`/m/…`).
 *
 * The wallet tab renders behind the overlay on purpose: dismissing a payment has
 * to land somewhere, and "somewhere" is the payer's own wallet, not a blank page
 * or a redirect that costs a round trip on the one path a stranger reaches by
 * pointing a phone at a piece of printed paper.
 */
export function PayerApp({ initialOverlay }: { initialOverlay: Overlay }) {
  return (
    <PayerProvider initialOverlay={initialOverlay}>
      <PayerFrame>
        <WalletScreen />
      </PayerFrame>
    </PayerProvider>
  );
}
