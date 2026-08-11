"use client";

/**
 * Which key the payer app signs with, when the build offers a choice.
 *
 * `NEXT_PUBLIC_DEMO_KEY` decides whether there is a choice at all: without it
 * there is only a connected wallet and none of this applies. With it, the demo
 * account is the default — the printed QR, the faucet and the seeded history all
 * assume it — and this is the opt-out.
 *
 * **This is not the URL override that was deleted.** That one let a query
 * parameter and an env value disagree about who signs, silently, on a link
 * someone else had sent. This is a persisted choice the payer makes on their own
 * settings screen and can see stated back to them there. The rule it keeps is
 * the same one: exactly one signer, and no ambiguity about which.
 *
 * Reading is deliberately confined to after mount — `localStorage` does not
 * exist during a server render, and an identity that differs between the server
 * and the first client paint is a hydration mismatch on the one value the whole
 * app is keyed to.
 */

const KEY = "gantry.payer.signer";

export type SignerPreference = "demo" | "connected";

export function readSignerPreference(): SignerPreference {
  if (typeof window === "undefined") return "demo";
  try {
    return window.localStorage.getItem(KEY) === "connected" ? "connected" : "demo";
  } catch {
    // Private mode, or storage disabled. The default is the one that works
    // without any user action, so failing to read it is not worth an error.
    return "demo";
  }
}

/**
 * Records the choice and RELOADS.
 *
 * The reload is the point, not laziness. `usePayerIdentity` is called from
 * several components and the payer store memoises against its result, so a
 * preference changed in one of them would leave the others signing as the
 * previous account until something happened to re-render them — two live
 * subscriptions disagreeing about who the user is, which is precisely the class
 * of bug that made `writeContract` send from the wrong account once already.
 *
 * Switching signers is a rare, deliberate act. Paying for it with a page load
 * buys a guarantee that every screen agrees.
 */
export function switchSigner(preference: SignerPreference): void {
  try {
    window.localStorage.setItem(KEY, preference);
  } catch {
    // Nothing to fall back to: without storage the choice cannot persist, and
    // reloading into the old identity would be worse than saying so.
    throw new Error(
      "This browser is blocking local storage, so the choice of wallet cannot be saved.",
    );
  }
  window.location.reload();
}
