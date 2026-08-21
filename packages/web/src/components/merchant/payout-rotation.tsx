"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { Address, Hex } from "viem";
import { basescanAddress, basescanTx, normalizePayout, shortAddress } from "@gantry/shared";
import { Card, Label, Mono, useToast } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { UnknownOutcomeError } from "@/lib/confirm-tx";
import { describeWriteError } from "@/lib/write-error";
import { useMerchantContext } from "./merchant-context";
import { usePayoutWrites } from "./payout-writes";

/**
 * Loaded only when a merchant opens the rotation form.
 *
 * A static import put RainbowKit's whole connector modal into the first load of
 * whichever screen hosts this, for a control most merchants will never touch,
 * on a back-office likely to be left open on a counter behind a venue hotspot.
 * `ssr: false` because it reads browser wallet state and has nothing to render
 * on a server.
 */
const ConnectButton = dynamic(
  () => import("@rainbow-me/rainbowkit").then((mod) => mod.ConnectButton),
  {
    ssr: false,
    loading: () => <span className="text-meta text-faint">Loading wallet options…</span>,
  },
);

/** How long to keep asking the backend to catch up with a rotation we have a
 * receipt for. The merchant sees nothing of this — the record was already
 * replaced optimistically — so it is purely about leaving the cache consistent
 * for the next screen that reads it. */
const REREAD_ATTEMPTS = 6;
const REREAD_POLL_MS = 2_000;

/**
 * Where the money lands, and the one control in this back-office that the chain
 * authenticates.
 *
 * `setMerchantPayout` is gated on `msg.sender == merchant.payout`, so it is
 * signed by the wallet already being paid and the relayer cannot help. That is
 * worth stating plainly, because the back-office is still open to READ: anyone
 * with the URL can see a shop's takings, and the reason they cannot redirect its
 * money is this line in the contract rather than anything in front of it.
 *
 * It is no longer the ONLY authenticated action here. Since 21 Aug a profile edit
 * carries a signature from this same address (`profile-writes.ts`), which the
 * backend checks before relaying — the difference being that this one is a
 * transaction the merchant sends and pays for, and that one is a signature the
 * relayer acts on.
 *
 * It lives on Settings rather than Payouts because it is a configuration
 * change, not a view of what has been paid — and because a destructive,
 * irreversible control does not belong on the screen a merchant opens to check
 * their takings.
 */
export function PayoutRotationCard() {
  const { merchant, replace } = useMerchantContext();
  const { signer, setMerchantPayout } = usePayoutWrites();
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<{ text: string; txHash: Hex; attempted: Address } | null>(
    null,
  );
  /** The confirmed rotation, kept on screen so the merchant has the receipt.
   * A change to where money goes is the one edit in this app worth being able
   * to point at afterwards, and the hash is the only durable proof of it. */
  const [done, setDone] = useState<{ payout: Address; txHash: Hex } | null>(null);
  /** Set while the backend's 60s merchant cache still reports the old payout.
   * Deliberately invisible: the record was already replaced from the receipt,
   * so there is nothing for a merchant to do or know, and a note that appears
   * and then removes itself is a layout shift for no information. */
  const [reconciling, setReconciling] = useState<Address | null>(null);

  const handle = merchant?.handle;
  useEffect(() => {
    if (!reconciling || !handle) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const fresh = await api.merchant(handle);
        if (cancelled) return;
        if (fresh.payout.toLowerCase() === reconciling.toLowerCase()) {
          // Adopt the whole fresh record: it is now the authoritative one and
          // may carry other edits made elsewhere.
          replace(fresh);
          setReconciling(null);
          return;
        }
      } catch (err) {
        // Says nothing about the rotation, which is mined.
        console.warn("gantry: could not re-read the merchant after a payout rotation", err);
      }
      if (cancelled) return;
      attempt += 1;
      if (attempt >= REREAD_ATTEMPTS) {
        console.warn("gantry: backend still reports the previous payout after a confirmed rotation");
        setReconciling(null);
        return;
      }
      timer = setTimeout(() => void tick(), REREAD_POLL_MS);
    };
    timer = setTimeout(() => void tick(), REREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `handle`, not `merchant`: the optimistic replace changes the record's
    // identity, and depending on the object would tear this poll down and
    // restart it, resetting its own attempt counter every time it progressed.
  }, [reconciling, handle, replace]);

  if (!merchant) return null;

  const current = merchant.payout;
  const isPayout = signer !== null && signer.toLowerCase() === current.toLowerCase();

  const submit = async () => {
    const parsed = normalizePayout(next);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    if (parsed.address.toLowerCase() === current.toLowerCase()) {
      setError("That is already this shop's payout address, so there is nothing to change.");
      return;
    }
    setError(null);
    setUnresolved(null);
    // `done` too. It is a claim about where money goes now, and leaving it up
    // while a SECOND attempt is in flight puts two contradictory statements in
    // one card: "Payouts now go to A" over "a change to B is unconfirmed, so
    // this may no longer be current".
    setDone(null);
    setBusy(true);
    try {
      const txHash = await setMerchantPayout(merchant.merchantId, parsed.address);
      // Optimistic, and justified: we hold a mined receipt, which outranks a
      // cached read. Through `replace` rather than `reload` so the record moves
      // WITHOUT a status transition — the shell swaps every screen for its gate
      // on "loading", which would unmount this card mid-flow, and the sidebar
      // footer renders `merchant.payout` from this same context and would
      // otherwise keep showing the old address beside a card showing the new.
      replace({ ...merchant, payout: parsed.address });
      setDone({ payout: parsed.address, txHash });
      setReconciling(parsed.address);
      setEditing(false);
      setNext("");
      toast.success("Payouts now go to the new address.");
    } catch (err) {
      if (err instanceof UnknownOutcomeError) {
        setUnresolved({
          text: "The change was submitted and we couldn't confirm it in time. It may still be landing. Check the transaction before sending it again: if it did land, this wallet can no longer make the change, because it is no longer the payout address, and a second attempt would be refused for that reason rather than because the first one failed.",
          txHash: err.txHash,
          attempted: parsed.address,
        });
        // An unresolved write must not invite a blind retry, and an enabled
        // submit button still pre-filled with the same address is an invitation
        // whatever the prose above it says.
        setEditing(false);
        setNext("");
      } else {
        // Shortened for the screen; the full wallet text goes to the console
        // so nothing is lost from a debugging session.
        console.warn("gantry: payout rotation failed", err);
        setError(describeWriteError(err).headline);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card radius="card" pad="lg" className="flex flex-col">
      <Label size="lg">Payout address</Label>
      <Mono size="md" breakAll className="mt-3.5 text-body-lg">
        {current}
      </Mono>
      {unresolved ? (
        <p className="mt-2 text-fine text-danger">
          A change to {shortAddress(unresolved.attempted)} is unconfirmed, so this may not be
          current.
        </p>
      ) : null}
      <a
        className="focus-ring mt-3 w-fit rounded-badge text-body"
        href={basescanAddress(current)}
        target="_blank"
        rel="noreferrer"
      >
        View on Basescan ↗
      </a>

      <p className="mt-4.5 text-meta text-muted">
        Every payment settles here inside the same transaction. Changing it is signed by this
        address itself, so nobody else can redirect your takings, including us.
      </p>

      {/* The receipt for a confirmed change, kept until the screen is left. */}
      {done ? (
        <Card tone="fill" radius="control-m" pad="none" className="mt-4 px-4.5 py-4">
          <p className="text-meta text-muted">
            Payouts now go to {shortAddress(done.payout)}. Every payment from here settles there.
          </p>
          <a
            href={basescanTx(done.txHash)}
            target="_blank"
            rel="noreferrer"
            className="focus-ring mt-2 inline-block rounded-badge text-meta text-accent underline-offset-2 hover:underline"
          >
            View the change on Basescan ↗
          </a>
        </Card>
      ) : null}

      {editing ? (
        <div className="mt-4 border-t border-hairline pt-4">
          {isPayout ? (
            <>
              <label className="flex flex-col gap-1.75">
                <span className="text-key font-medium">New payout address</span>
                <Input
                  value={next}
                  onChange={(event) => setNext(event.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-mono"
                />
              </label>
              {/* The rule that makes a typo unrecoverable, said before the
                  transaction rather than after it: the new address becomes the
                  only one that can rotate again. */}
              <p className="mt-2 text-fine text-faint">
                Check it character by character. Once this lands, only the new address can change
                it again.
              </p>
              <div className="mt-3.5 flex gap-2.5">
                <Button size="sm" onClick={() => void submit()} disabled={busy || next.trim() === ""}>
                  {busy ? "Confirming…" : "Change payout address"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                    setNext("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              {/*
               * Names WHICH wallet, and why, before asking for a connection.
               *
               * This read "Connect the wallet that receives this shop's
               * payouts", which a merchant reasonably took to mean the wallet
               * they wanted to be paid at from now on — the exact opposite of
               * what the contract needs. `setMerchantPayout` is gated on the
               * CURRENT payout, so the address being replaced is the one that
               * has to sign. Saying so, showing it, and saying that the new
               * address is asked for afterwards removes the reading that sent
               * someone to connect the wrong account.
               */}
              <p className="text-meta text-muted">
                {signer === null
                  ? "This change is signed by the address that is paid today, not by the new one. Connect the wallet holding "
                  : `You are connected as ${shortAddress(signer)}, which is not the address paid today. Switch to `}
                <Mono size="sm">{shortAddress(current)}</Mono>
                {signer === null
                  ? " to continue. You will enter the new address on the next step."
                  : " to continue. The contract accepts this change from that address and no other."}
              </p>
              <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
                <ConnectButton showBalance={false} chainStatus="none" />
                <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </>
          )}
          {error ? <p className="mt-3 text-meta text-danger break-words">{error}</p> : null}
        </div>
      ) : (
        <Button variant="secondary" size="sm" className="mt-4 w-fit" onClick={() => setEditing(true)}>
          Change payout address
        </Button>
      )}

      {unresolved ? (
        <Card tone="sunken" radius="control-m" pad="none" className="mt-3.5 px-4.5 py-4">
          <p className="text-meta-sm text-muted break-words">{unresolved.text}</p>
          <a
            href={basescanTx(unresolved.txHash)}
            target="_blank"
            rel="noreferrer"
            className="focus-ring mt-2.5 inline-block rounded-badge text-meta text-accent underline-offset-2 hover:underline"
          >
            Check {shortAddress(unresolved.txHash)} on Basescan
          </a>
        </Card>
      ) : null}
    </Card>
  );
}
