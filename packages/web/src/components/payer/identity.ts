"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { getDemoAccount } from "@/lib/demo-account";
import { demoAccountEnabled } from "@/lib/env";
import { readSignerPreference, type SignerPreference } from "@/lib/payer-signer";

/**
 * Who the payer is, from the ONE key source in effect.
 *
 * `NEXT_PUBLIC_DEMO_KEY` decides what is on offer: a pinned 32-byte key means
 * the app can sign for itself, anything else means only a connected wallet can.
 * There is no per-device mode (it went when agents became payer-owned on-chain —
 * a fresh random address owns nothing and every agent screen renders empty for
 * it) and no URL override, because env and URL disagreeing about who signs is a
 * class of bug that only ever shows up on stage.
 *
 * On a build that HAS the demo key, the payer may opt out of it from the
 * settings screen — see `lib/payer-signer`. That is a stored, visible choice
 * rather than a second configuration channel, and switching reloads the page so
 * that no two components can be holding different answers to this question.
 */
export interface PayerIdentity {
  address: Address | null;
  demo: boolean;
  /** A wallet is connected. Only meaningful when `demo` is false. */
  connected: boolean;
  /**
   * False while the answer is still unknown: wagmi reconnects asynchronously,
   * and both the demo account and the stored preference are resolved after mount
   * (see below). Screens must distinguish this from "no wallet" — one is a
   * spinner, the other is an empty state, and showing the empty state for half a
   * second on every load reads as broken.
   */
  ready: boolean;
  /**
   * This build carries a demo key, so the payer has a choice to make and the
   * settings screen has a control to show. Independent of `demo`, which says
   * which side of that choice is currently in force.
   */
  demoConfigured: boolean;
}

export function usePayerIdentity(): PayerIdentity {
  const demoConfigured = demoAccountEnabled();
  const { address: connectedAddress, status } = useAccount();
  const [demoAddress, setDemoAddress] = useState<Address | null>(null);
  /** null until read from storage — which is NOT the same as "demo". Defaulting
   * before the read would sign the first frame as the demo account for a payer
   * who has chosen their own wallet. */
  const [preference, setPreference] = useState<SignerPreference | null>(null);

  useEffect(() => {
    setPreference(readSignerPreference());
  }, []);

  const demo = demoConfigured && preference === "demo";

  useEffect(() => {
    if (!demo) return;
    // Resolved after mount rather than during render. The key itself is a
    // build-time inlined env value now — there is no per-device localStorage
    // burner any more — but deriving the address means running secp256k1 on it,
    // which is pure client work with no business happening during a server
    // render.
    setDemoAddress(getDemoAccount().address);
  }, [demo]);

  // Memoised because this object is a dependency of the payer store's own memo;
  // a fresh one every render would re-run every consumer on every keystroke.
  return useMemo(() => {
    if (preference === null) {
      // The choice has not been read yet, so there is no honest answer to give.
      return { address: null, demo: false, connected: false, ready: false, demoConfigured };
    }
    return demo
      ? {
          address: demoAddress,
          demo: true,
          connected: false,
          ready: demoAddress !== null,
          demoConfigured,
        }
      : {
          address: connectedAddress ?? null,
          demo: false,
          connected: Boolean(connectedAddress),
          ready: status !== "connecting" && status !== "reconnecting",
          demoConfigured,
        };
  }, [demo, demoConfigured, demoAddress, connectedAddress, status, preference]);
}
