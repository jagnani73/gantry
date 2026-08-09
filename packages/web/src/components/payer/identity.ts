"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { getDemoAccount } from "@/lib/demo-account";
import { demoAccountEnabled } from "@/lib/env";

/**
 * Who the payer is, from the ONE configured key source.
 *
 * `NEXT_PUBLIC_DEMO_KEY` decides: a pinned 32-byte key means the app signs for
 * itself, anything else means a connected wallet does. There is no per-device
 * mode (it went when agents became payer-owned on-chain — a fresh random address
 * owns nothing and every agent screen renders empty for it), no URL override and
 * no runtime toggle, because env and URL disagreeing about who signs is a class
 * of bug that only ever shows up on stage.
 */
export interface PayerIdentity {
  address: Address | null;
  demo: boolean;
  /** A wallet is connected. Only meaningful when `demo` is false. */
  connected: boolean;
  /**
   * False while the answer is still unknown: wagmi reconnects asynchronously,
   * and the demo account is resolved after mount (see below). Screens must
   * distinguish this from "no wallet" — one is a spinner, the other is an empty
   * state, and showing the empty state for half a second on every load reads as
   * broken.
   */
  ready: boolean;
}

export function usePayerIdentity(): PayerIdentity {
  const demo = demoAccountEnabled();
  const { address: connectedAddress, status } = useAccount();
  const [demoAddress, setDemoAddress] = useState<Address | null>(null);

  useEffect(() => {
    if (!demo) return;
    // Resolved after mount rather than during render. The key itself is a
    // build-time inlined env value now — there is no per-device localStorage
    // burner any more, so there is no hydration mismatch left to avoid — but
    // deriving the address means running secp256k1 on it, which is pure client
    // work with no business happening during a server render.
    setDemoAddress(getDemoAccount().address);
  }, [demo]);

  // Memoised because this object is a dependency of the payer store's own memo;
  // a fresh one every render would re-run every consumer on every keystroke.
  return useMemo(
    () =>
      demo
        ? { address: demoAddress, demo: true, connected: false, ready: demoAddress !== null }
        : {
            address: connectedAddress ?? null,
            demo: false,
            connected: Boolean(connectedAddress),
            ready: status !== "connecting" && status !== "reconnecting",
          },
    [demo, demoAddress, connectedAddress, status],
  );
}
