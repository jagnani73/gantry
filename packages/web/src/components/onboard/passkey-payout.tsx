"use client";

import { useState } from "react";
import type { Address } from "viem";
import { useAccount, useConnect } from "wagmi";
import { shortAddress } from "@gantry/shared";
import { Mono } from "@/components/primitives";
import { describeWriteError } from "@/lib/write-error";
import { cn } from "@/lib/utils";

/**
 * Making a payout address for a merchant who has never held one.
 *
 * The rest of onboarding asks a hawker to paste a hex string, which is the
 * least realistic step in the whole flow: the demo says he has never heard of a
 * blockchain, and then the form asks for something only a wallet can give him.
 * This is the other half of that sentence — a passkey creates the account with
 * whatever unlocks his phone, and the address drops into the field.
 *
 * WHY THIS IS SAFE TO DO HERE, and why it is not the merchant back-office's
 * payout rotation wearing a different hat: registration is RELAYER-PAID. The
 * form sends an address to `POST /api/merchants` and the backend's gas key
 * makes the transaction, so this account never signs anything and never needs
 * ETH. That is what keeps `confirm-tx.ts` out of this path entirely — its
 * receipt discipline is built on EOA nonce semantics (`onReplaced` scans for a
 * transaction with the same `from` and `nonce`), which a 4337 account does not
 * have. Rotating a payout FROM a smart account is a different problem and is
 * deliberately not solved here.
 *
 * The address is counterfactual until the account's first outgoing
 * transaction, and that is fine for the thing it is used for: an ERC-20
 * transfer only writes to the token's own balance mapping and never calls the
 * recipient, so XSGD lands here from the first payment whether or not the
 * account has been deployed. Moving it out later is a UserOperation through
 * Base's own app — which is the honest division of labour, since Gantry's gas
 * model is EOA-shaped throughout and it holds no key of the merchant's.
 */

/**
 * The wagmi connector id, which is NOT RainbowKit's wallet id.
 *
 * RainbowKit lists this wallet as `base` (with `baseAccount` among its
 * aliases); the underlying wagmi connector it builds identifies itself as
 * `baseAccount`. `connectors` here comes from wagmi, so it is the latter that
 * matches — the two are separate registries and the wrong one silently finds
 * nothing, leaving a button that does nothing at all.
 */
const PASSKEY_CONNECTOR_ID = "baseAccount";

export function PasskeyPayout({
  onAddress,
  disabled,
  className,
}: {
  onAddress: (address: Address) => void;
  disabled: boolean;
  className?: string;
}) {
  const { connectors, connectAsync, status } = useConnect();
  const { address, connector: active } = useAccount();
  const [failure, setFailure] = useState<string | null>(null);

  const passkey = connectors.find((c) => c.id === PASSKEY_CONNECTOR_ID);
  const pending = status === "pending";

  // Nothing to offer if the connector is absent. It ships in RainbowKit's
  // default wallet list, so this is a "someone narrowed the list" guard rather
  // than an expected state — but an inert button is worse than no button.
  if (!passkey) return null;

  async function create() {
    setFailure(null);
    try {
      // Already on this connector: connecting again would throw rather than
      // hand back the account we can already see.
      if (active?.id === PASSKEY_CONNECTOR_ID && address) {
        onAddress(address);
        return;
      }
      const result = await connectAsync({ connector: passkey! });
      const account = result.accounts[0];
      if (!account) {
        setFailure("The wallet connected without returning an address. Try again.");
        return;
      }
      onAddress(account);
    } catch (err) {
      console.warn("passkey payout connect failed", err);
      const { headline, rejected } = describeWriteError(err);
      // A cancelled passkey prompt is a decision, not a fault: say nothing and
      // leave the paste-an-address path exactly where it was.
      setFailure(rejected ? null : headline);
    }
  }

  const mine = active?.id === PASSKEY_CONNECTOR_ID ? address : undefined;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          disabled={disabled || pending}
          onClick={() => void create()}
          className={
            "focus-ring inline-flex items-center justify-center rounded-control bg-fill-subtle " +
            "px-4 py-2.5 text-btn-sm font-medium text-quiet transition-colors " +
            "hover:bg-fill-hover-strong disabled:pointer-events-none disabled:opacity-60"
          }
        >
          {pending ? "Waiting for your passkey…" : mine ? "Use this account" : "Create one with a passkey"}
        </button>
        {mine && (
          <Mono size="3xs" tone="muted">
            {shortAddress(mine)}
          </Mono>
        )}
      </div>
      <p className={cn("text-fine", failure ? "text-danger" : "text-faint")}>
        {failure ??
          "No wallet? Make one with your face or fingerprint — no app, no seed phrase. " +
            "Gantry never holds the key, and you move money out from the Base app rather than here."}
      </p>
    </div>
  );
}
