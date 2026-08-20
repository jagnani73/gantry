"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
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
 *
 * These are the two ENTRY routes, and this component is where that fact lives —
 * the provider is told, and never works it out from a pathname. What the routes
 * are is the same thing said twice: the pathname IS the overlay (so it needs no
 * query of its own), and there is nothing underneath it (so an emptied stack has
 * to leave). The second half is what fixes the reported bug: closing the overlay
 * on `/pay/ah-hock-chicken-rice` used to leave the payer on the wallet screen
 * while the URL still named a payment, and a refresh dropped them straight back
 * into the half-finished one.
 */
export function PayerApp({ initialOverlay }: { initialOverlay: Overlay }) {
  const router = useRouter();
  const pathname = usePathname();

  /* `replace`, not `push`. The overlay has just been dismissed, so a history
     entry for it would make Back re-enter the payment the payer closed — the
     same rule the sync inside the provider follows, and the same one the
     merchant directory's drawer follows. */
  const exit = useCallback(() => router.replace("/app"), [router]);

  /* Memoised so the provider's effects see a stable object. `initialOverlay`
     comes across the server boundary and is stable per navigation, so this only
     has to survive re-renders of this component. */
  const entry = useMemo(() => ({ overlay: initialOverlay, exit }), [initialOverlay, exit]);

  /* Keyed on the pathname, which makes one illegal state unrepresentable.
     The provider captures the floor overlay ONCE in a ref, but `entry` is a prop
     and may change: a client navigation between two URLs matching the same route
     pattern — `/pay/a` → `/pay/b` — re-renders this component instead of
     remounting it, so the floor would still be shop A while the URL said shop B,
     and the amount pad would take a payment for the wrong shop. Nothing links
     one pay page to another today, so this costs a remount that never happens;
     it is one line standing in front of a signing screen. */
  return (
    <PayerProvider key={pathname} entry={entry}>
      <PayerFrame>
        <WalletScreen />
      </PayerFrame>
    </PayerProvider>
  );
}
