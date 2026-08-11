"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  agentStatus,
  basescanTx,
  BASE_SEPOLIA_ADDRESSES,
  CATEGORY_OPTIONS,
  formatUnits6,
  shortAddress,
  type AgentSummary,
} from "@gantry/shared";
import { Card, cn, Mono, useToast } from "@/components/primitives";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { describeWriteError } from "@/lib/write-error";
import {
  capUnitsFromSgd,
  categoryBitmapOf,
  categoryIdsOf,
  labelByteLength,
  LABEL_MAX_BYTES,
  policyFingerprint,
  sgdFromCapUnits,
} from "./agent-rules";
import { useAgentWrites, UnknownOutcomeError } from "./agent-writes";
import { OverlayHeader, OverlayScreen } from "./overlay";
import { usePayer } from "./payer-context";

/**
 * Create an agent, or change the rules of one.
 *
 * The signer address is a real input and cannot be derived: it is the public
 * address of whatever software will act as the agent — in this demo, the CLI's
 * session key. The app never holds that key, which is the whole point: the agent
 * signs spend authorizations, the wallet checks them against a policy only the
 * owner can set, and the owner is the person holding this phone.
 *
 * Editing has one rule that outranks the rest: `setPolicy` OVERWRITES the whole
 * policy struct and zeroes the wallet's `spentToday`, so every field must be
 * prefilled from what is actually on-chain and a save that changes nothing must
 * not be sent at all. The form therefore refuses to render until it has read the
 * policy it is about to replace.
 */

/** Caps are typed the way a price is: at most two decimals. */
const AMOUNT = /^\d+(\.\d{1,2})?$/;
const DEFAULT_DAYS = "30";
const MAX_DAYS = 365;
const DAY_SECONDS = 86_400;

export function AgentForm({ wallet }: { wallet: Address | null }) {
  const { popOverlay } = usePayer();

  // Read the wallet directly and use NOTHING else. The agents list is enumerated
  // from factory logs and can be a minute old; falling back to it whenever it
  // happened to have an entry — which is the normal path, since Edit is reached
  // by tapping an agent in that very list — is the stale prefill this form's
  // whole guard exists to prevent. `pnpm demo:reset` re-arms a 30-day policy
  // while the app is open; opening Edit on the older list and saving would
  // silently put the old caps back and reset `spentToday` with it.
  const [fresh, setFresh] = useState<AgentSummary | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    setReadError(null);
    api
      .agent(wallet)
      .then((summary) => {
        if (!cancelled) setFresh(summary);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn(`gantry: agent read failed for ${wallet}`, err);
        setReadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, reloadNonce]);

  const existing = wallet ? (fresh ?? undefined) : undefined;

  if (wallet && !existing) {
    return (
      <OverlayScreen>
        <OverlayHeader
          onBack={popOverlay}
          backLabel="Back"
          title="Edit rules"
          subtitle={shortAddress(wallet)}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          {readError === null ? (
            <p className="text-body text-muted">Reading this agent&apos;s current rules…</p>
          ) : (
            <>
              <p className="text-body text-muted">
                We couldn&apos;t read this agent&apos;s current rules, and saving would overwrite
                every one of them. Nothing has changed on-chain.
              </p>
              <p className="max-w-[34ch] text-fine text-faint break-words">{readError}</p>
              <button
                type="button"
                onClick={() => setReloadNonce((n) => n + 1)}
                className="focus-ring h-12 rounded-control-m bg-ink px-6 text-btn-sm text-paper transition-colors hover:bg-ink-hover"
              >
                Try again
              </button>
            </>
          )}
        </div>
      </OverlayScreen>
    );
  }

  // Keyed so a different wallet remounts rather than keeping the last one's
  // prefilled fields — every value below is a `useState` initializer, and an
  // initializer cannot be re-run by a prop arriving late. That is also why the
  // guard above must be a hard gate rather than a fallback: this only mounts
  // once `existing` is the wallet's own answer, so the frozen initializers and
  // the derived `initialDays` / `preservedExpiry` / `writesNothing` are all
  // reading the same snapshot.
  return <AgentFormFields key={wallet ?? "new"} wallet={wallet} existing={existing} />;
}

function AgentFormFields({
  wallet,
  existing,
}: {
  wallet: Address | null;
  existing: AgentSummary | undefined;
}) {
  const {
    expectAgentPolicy,
    rate: chainRate,
    chainNow: clock,
    refresh,
    popOverlay,
    replaceOverlay,
  } = usePayer();
  const { createWallet, setPolicy, setLabel, setAgentSigner, chainNow } = useAgentWrites();
  const toast = useToast();

  const rate = existing ? BigInt(existing.rate) : chainRate;

  // Chain seconds as of the moment this form opened. Frozen so the prefilled
  // "expires in" and the "did the payer touch it" comparison cannot drift apart
  // while the form is on screen.
  const [openedAt] = useState(() => clock());
  /**
   * This wallet cannot spend right now, and saving is what changes that.
   *
   * `setPolicy` overwrites the whole struct including a fresh expiry, so it is
   * the ONLY way back from a revoke — there is no separate un-revoke — and
   * nothing on the form said that saving would bring a dead agent back to life.
   *
   * The two dead states are kept APART because they leave the form looking
   * completely different, and one sentence for both was wrong about one of
   * them. A revoke zeroes the caps and the category bitmap, so the fields open
   * empty and `validate` blocks Save until real ones are typed. A LAPSED policy
   * has cleared nothing: every cap and category is still on-chain and still
   * prefilled, only `expiry` is in the past — so Save is live on first paint,
   * and telling that payer their limits "were cleared" contradicts the
   * populated fields three inches below.
   */
  const status = existing ? agentStatus(existing, openedAt) : null;
  const reArming = status !== null && status !== "active";
  const initialDays = daysRemaining(existing, openedAt);
  /** The absolute expiry already on-chain, when it is still in the future. An
   * untouched expiry field re-sends THIS rather than `now + days`, so opening
   * the form to add a category cannot quietly move the date. */
  const preservedExpiry = existing && existing.expiry > openedAt ? existing.expiry : null;

  // From the wallet, not from this browser: the label is on-chain, so the form
  // must prefill from the same place `setLabel` will write.
  const [name, setName] = useState(() => existing?.label ?? "");
  const [signer, setSigner] = useState(existing?.agentSigner ?? "");
  const [dailyCap, setDailyCap] = useState(() =>
    existing && rate ? sgdFromCapUnits(existing.dailyCap, rate) : "50.00",
  );
  const [perTxCap, setPerTxCap] = useState(() =>
    existing && rate ? sgdFromCapUnits(existing.perTxCap, rate) : "10.00",
  );
  const [categories, setCategories] = useState<number[]>(() =>
    existing ? categoryIdsOf(BigInt(existing.categoryBitmap)) : [1],
  );
  const [days, setDays] = useState(initialDays);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * A wallet this form DEPLOYED, before its policy was armed.
   *
   * Creating an agent is two transactions and the first one is irreversible. If
   * the second fails, the wallet exists — and the only button on screen used to
   * say "try again", which deployed a second one for the same signer. Holding
   * the address here makes the retry arm THIS wallet instead. It cannot spend
   * anything meanwhile: an unarmed policy is all zeroes, so `expiry == 0` and
   * every authorization reverts `PolicyExpired`.
   */
  const [createdWallet, setCreatedWallet] = useState<Address | null>(null);
  /** A write that was broadcast and not confirmed. Never rendered as a failure —
   * see `UnknownOutcomeError`. */
  const [unresolved, setUnresolved] = useState<{ text: string; txHash: Hex } | null>(null);

  const problem = validate({ wallet, signer, name, dailyCap, perTxCap, categories, days, rate });

  const expiryUnchanged = preservedExpiry !== null && days === initialDays;
  /** Every field of the POLICY is identical to what the wallet already holds, so
   * `setPolicy` has nothing to write. Compared in contract units, not in S$,
   * because that is what it will be handed.
   *
   * The label is NOT part of this. It is a separate transaction (`setLabel`
   * does not touch the policy, and `setPolicy` deliberately does not carry the
   * name — that call resets the daily counter, and a rename must never cost the
   * agent its budget), so the two "did anything change" questions are separate
   * and a save may send one, both, or neither. */
  const policyUnchanged =
    existing !== undefined &&
    problem === null &&
    rate !== null &&
    expiryUnchanged &&
    capUnitsFromSgd(dailyCap.trim(), rate) === BigInt(existing.dailyCap) &&
    capUnitsFromSgd(perTxCap.trim(), rate) === BigInt(existing.perTxCap) &&
    categoryBitmapOf(categories) === BigInt(existing.categoryBitmap);

  const labelUnchanged = existing !== undefined && name.trim() === existing.label;
  /** Compared checksum-insensitively, because the field is prefilled from a
   * chain read in EIP-55 and a payer who retypes the same address in lowercase
   * has not asked for a rotation — sending one would cost gas to write the value
   * already there. `isAddress` has already passed by the time this matters; an
   * unparseable string fails `validate` and never reaches a write. */
  const signerUnchanged =
    existing !== undefined && signer.trim().toLowerCase() === existing.agentSigner.toLowerCase();
  const writesNothing = policyUnchanged && labelUnchanged && signerUnchanged;

  // `setPolicy` zeroes `_spentToday`. That is deliberate — it is what makes the
  // rehearsal re-arm work — but it is also an allowance the agent gets back, so
  // it is stated BEFORE the payer taps Save rather than discovered afterwards.
  // Keyed on the POLICY write specifically: a rename alone leaves it standing.
  const resetsCounter =
    existing !== undefined && !policyUnchanged && BigInt(existing.spentToday) > 0n && rate !== null;

  const submit = async () => {
    if (problem || !rate) return;
    setError(null);
    setUnresolved(null);
    // Hoisted out of the try because the catch needs it: `setCreatedWallet` does
    // not update the value this closure captured, so reading the state variable
    // down there would report "no wallet was deployed" about the run that just
    // deployed one.
    let target: Address | null = createdWallet;
    /**
     * Which writes of this save are MINED, in order.
     *
     * A save can send two transactions, and the failure of the second says
     * nothing about the first. Without this the payer read a bare "User rejected
     * the request" over figures that looked unchanged and reasonably concluded
     * nothing had happened — while `setPolicy` was already on-chain, and tapping
     * Save again re-sent it, paying gas and re-zeroing `spentToday` a second
     * time. Hoisted out of the `try` for the same reason `target` is: the catch
     * needs it.
     */
    const landed: FormWrite[] = [];
    try {
      const label = name.trim();

      if (wallet && writesNothing) {
        // No transaction at all: neither the policy nor the label differs from
        // what the wallet already holds. Sending anyway would cost gas for no
        // change AND hand the agent a fresh daily allowance.
        //
        // Worded as a claim about the READ, not about the chain. `existing` is
        // the snapshot this form opened with, and `demo:reset` re-arms a policy
        // while the app is open — as can another visitor, since a deployed build
        // signs with one shared key — so "the wallet already holds these" is a
        // stronger statement than anything here can support.
        toast.success("No change. This matches what we read off the wallet.");
        popOverlay();
        return;
      }

      // The expiry is absolute on-chain and derived from CHAIN time: a laptop
      // running minutes fast would otherwise arm a policy the wallet considers
      // already dead. An untouched field keeps the date the wallet already has.
      const expiry = expiryUnchanged
        ? preservedExpiry!
        : (await chainNow()) + Number(days) * DAY_SECONDS;
      const policy = {
        dailyCap: capUnitsFromSgd(dailyCap.trim(), rate),
        perTxCap: capUnitsFromSgd(perTxCap.trim(), rate),
        expiry,
        categoryBitmap: categoryBitmapOf(categories),
      };

      if (wallet) {
        // Up to three transactions, and only the ones that change something.
        // The order is by consequence, so that whatever a rejected later prompt
        // leaves behind is the half that matters: rules, then who may spend
        // under them, then the display name. Never a rename over rules that
        // stayed as they were.
        //
        // EVERY branch records the expectation as soon as its write mines, and
        // there is deliberately no single call after all three. A terminal call
        // is unreachable the moment any earlier write fails, which is exactly
        // when the expectation matters most — and the version of this code that
        // had one left `setAgentSigner` recording nothing at all, so a rotation
        // followed by a failed rename left the store naming the OLD signer. The
        // detail screen can never match that, so it hid itself for its whole
        // poll and then blamed the RPC for a bug in this function.
        //
        // The three locals track what the chain holds as we go, so each call
        // states the whole record rather than a fragment of it.
        let expectedPolicy: {
          dailyCap: bigint | string;
          perTxCap: bigint | string;
          expiry: number;
          categoryBitmap: bigint | string;
        } = existing!;
        let expectedSigner = existing!.agentSigner;
        let expectedLabel = existing!.label;
        const record = () =>
          expectAgentPolicy(
            wallet,
            policyFingerprint({
              ...expectedPolicy,
              label: expectedLabel,
              agentSigner: expectedSigner,
            }),
          );

        if (!policyUnchanged) {
          setBusy("Updating the policy on-chain…");
          await setPolicy(wallet, policy);
          // Recorded the instant it mines, NOT after every write. A rename that
          // then fails used to leave this unset, so the very next read was the
          // ungated too-early one this whole mechanism exists to catch — and the
          // payer was returned to the caps they had just replaced.
          landed.push("policy");
          expectedPolicy = policy;
          record();
        }
        if (!signerUnchanged) {
          setBusy("Rotating the session key on-chain…");
          const rotated = getAddress(signer.trim());
          await setAgentSigner(wallet, rotated);
          landed.push("signer");
          expectedSigner = rotated;
          record();
        }
        if (!labelUnchanged) {
          setBusy("Saving the name on-chain…");
          await setLabel(wallet, label);
          landed.push("name");
          expectedLabel = label;
          record();
        }
        toast.success(savedText(landed));
        refresh();
        popOverlay();
        return;
      }

      // Deploy only if we have not already. A second tap after a failed arming
      // must arm the wallet that exists, not mint another one for the same
      // signer.
      if (!target) {
        setBusy("Creating the wallet on-chain…");
        // The label rides in the deploy, so naming an agent costs no transaction
        // of its own and creating one stays two.
        target = (await createWallet(getAddress(signer.trim()), label)).wallet;
        setCreatedWallet(target);
        // `refresh()` puts the wallet in the agents list before the second
        // transaction can fail — otherwise a deployed wallet exists with nothing
        // on screen pointing at it.
        refresh();
      }

      setBusy("Arming its spend policy…");
      await setPolicy(target, policy);
      toast.success("Agent created and its rules armed.");
      // The signer went into the constructor, so it is the typed one by
      // definition — there is no `existing` on this path to read it from.
      expectAgentPolicy(
        target,
        policyFingerprint({ ...policy, label, agentSigner: getAddress(signer.trim()) }),
      );
      refresh();
      replaceOverlay({ kind: "agent", wallet: target });
    } catch (err) {
      if (err instanceof UnknownOutcomeError) {
        // Broadcast, outcome unknown. Never a red failure, and never a blind
        // retry: a second `createWallet` deploys a duplicate, and a second
        // `setPolicy` is at best pointless gas.
        setUnresolved({ text: unresolvedText(err, target, landed), txHash: err.txHash });
        // The agents list is where a deploy that did land will appear.
        refresh();
      } else {
        // Whatever already mined is reported FIRST. The wallet's own words for a
        // rejected second prompt are "User rejected the request", which says
        // nothing about the write that succeeded a moment earlier.
        console.warn("gantry: agent write failed", err);
        const failure = describeWriteError(err).headline;
        setError(landed.length > 0 ? `${landedText(landed)} ${failure}` : failure);
      }
      // A partial save moved the chain, so the list this form was prefilled from
      // is now wrong — and `existing` is the frozen open-time snapshot, so
      // without this a second Save re-sends a `setPolicy` that already mined.
      if (landed.length > 0) refresh();
    } finally {
      setBusy(null);
    }
  };

  /** The wallet these fields describe: the one being edited, or the one this
   * form deployed and has not finished arming. */
  const subject = wallet ?? createdWallet;

  return (
    <OverlayScreen>
      <OverlayHeader
        onBack={popOverlay}
        backLabel="Back"
        title={wallet ? (reArming ? "Arm this agent" : "Edit rules") : "New agent"}
        subtitle={subject ? shortAddress(subject) : undefined}
      />
      <div className="flex flex-col gap-3.5 px-5 pt-6 pb-11">
        {/* Stated before the fields, because the fields themselves are the clue
            and they read differently in each case — empty after a revoke, fully
            populated after a lapse. */}
        {reArming ? (
          <Card tone="sunken" radius="control-m" pad="none" className="px-4.5 py-4">
            <p className="text-meta-sm text-muted">
              {status === "revoked"
                ? "This agent is revoked and cannot spend. Its caps and categories were cleared, so they start empty here. Saving writes a new policy on-chain and lets it spend again from that moment."
                : "This agent's policy has expired, so it cannot spend. Its old limits are still below, unchanged. Saving writes them again with a new expiry and lets it spend from that moment."}
            </p>
          </Card>
        ) : null}
        <Card radius="card-m" pad="none" className="flex flex-col gap-4 px-5 py-5">
          {/* The hint here read "Yours alone. It stays in this browser and never
              leaves it." That was true of the localStorage map this replaced and
              is now the opposite of true: the name is stored on the wallet, so it
              is public, permanent and — on a build where every visitor shares one
              demo key — written by an account that is not just yours. Collecting
              it under the old promise is the kind of label this project treats as
              a bug. The transaction cost belongs here too: a payer told the name
              stays local has no reason to expect a second wallet prompt. */}
          <Field
            label="Name"
            hint={
              wallet
                ? "Stored on the wallet, so it's public. Renaming costs a transaction."
                : "Stored on the wallet, so it's public. Set here, it costs no extra transaction."
            }
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Kopi Runner"
              // Matches the contract's bound for the ASCII case. A multi-byte
              // name can still exceed 31 BYTES inside 31 characters, which
              // `validate` catches — the contract counts bytes.
              maxLength={31}
            />
          </Field>

          {/* Editable on an existing wallet, because `setAgentSigner` is
              `onlyOwner` and the payer is the owner — this field used to say
              "Fixed for the life of this wallet", which the contract flatly
              contradicts and which left a leaked session key with no answer
              but abandoning the wallet and its balance.

              Still locked on a wallet this form JUST deployed: the signer went
              into the constructor moments ago, the policy behind it is not
              armed yet, and rotating between those two writes describes a
              wallet that is not the one being armed. */}
          <Field
            label="Agent signer"
            hint={
              createdWallet
                ? "Set when this wallet was created a moment ago."
                : wallet
                  ? "Rotating this is its own transaction. It replaces who may spend and leaves the caps, categories and today's spend exactly as they are."
                  : "The public address of the software that will act as this agent."
            }
          >
            <Input
              value={signer}
              onChange={(event) => setSigner(event.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              disabled={createdWallet !== null}
              className="font-mono text-mono"
            />
          </Field>
        </Card>

        <Card radius="card-m" pad="none" className="flex flex-col gap-4 px-5 py-5">
          <div className="flex gap-3">
            <Field label="Daily cap" className="flex-1">
              <Input
                value={dailyCap}
                inputMode="decimal"
                onChange={(event) => setDailyCap(event.target.value)}
                className="font-mono text-mono"
              />
            </Field>
            <Field label="Per payment" className="flex-1">
              <Input
                value={perTxCap}
                inputMode="decimal"
                onChange={(event) => setPerTxCap(event.target.value)}
                className="font-mono text-mono"
              />
            </Field>
          </div>
          <p className="text-fine text-faint">
            In S$. The contract stores USDC, so these convert at the swap&apos;s owner-set rate and
            the wallet enforces the converted figure.
          </p>

          <Field label="Allowed at">
            <div className="flex flex-wrap gap-2">
              {CATEGORY_OPTIONS.map((option) => {
                const on = categories.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setCategories((prev) =>
                        prev.includes(option.id)
                          ? prev.filter((id) => id !== option.id)
                          : [...prev, option.id],
                      )
                    }
                    className={cn(
                      "focus-ring rounded-chip px-3 py-2 text-chip transition-colors",
                      on ? "bg-accent-tint text-accent" : "bg-fill-subtle text-quiet",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field
            label="Expires in"
            hint={
              existing
                ? "Days from now. Leave it alone and the date already on the wallet is kept."
                : "Days from now. The wallet stores an absolute date."
            }
          >
            <Input
              value={days}
              inputMode="numeric"
              onChange={(event) => setDays(event.target.value)}
              className="font-mono text-mono"
            />
          </Field>
        </Card>

        {resetsCounter && existing && rate ? (
          <Card tone="sunken" radius="control-m" pad="none" className="px-4.5 py-4">
            <p className="text-meta-sm text-muted">
              Saving replaces the whole policy on-chain, which also resets today&apos;s spend
              counter. This agent has spent S${sgdFromCapUnits(existing.spentToday, rate)} today; a
              save gives it the full daily cap again until the window rolls at 08:00 SGT.
            </p>
          </Card>
        ) : null}

        {error ? (
          <Card tone="danger" radius="control-m" pad="none" className="px-4.5 py-4">
            <p className="text-meta break-words">{error}</p>
          </Card>
        ) : null}

        {unresolved ? (
          <Card tone="sunken" radius="control-m" pad="none" className="px-4.5 py-4">
            <p className="text-meta-sm text-muted break-words">{unresolved.text}</p>
            <div className="mt-2.5 flex flex-col gap-1.5">
              <a
                href={basescanTx(unresolved.txHash)}
                target="_blank"
                rel="noreferrer"
                className="focus-ring rounded-badge text-meta text-accent underline-offset-2 hover:underline"
              >
                Check {shortAddress(unresolved.txHash)} on Basescan
              </a>
              {createdWallet ? (
                <button
                  type="button"
                  onClick={() => replaceOverlay({ kind: "agent", wallet: createdWallet })}
                  className="focus-ring self-start rounded-badge text-meta text-accent underline-offset-2 hover:underline"
                >
                  Open this agent
                </button>
              ) : null}
            </div>
          </Card>
        ) : null}

        <button
          type="button"
          disabled={Boolean(problem) || busy !== null}
          onClick={() => void submit()}
          className="focus-ring h-13.5 rounded-control-m bg-ink text-btn text-paper transition-colors hover:bg-ink-hover disabled:bg-nav-active disabled:text-faintest"
        >
          {busy ??
            (wallet
              ? writesNothing
                ? "Done"
                : reArming
                  ? "Arm this agent again"
                  : "Save rules"
              : createdWallet
                ? "Arm this wallet's policy"
                : "Create agent")}
        </button>
        <p className="px-1 text-center text-fine text-faint">
          {problem ??
            (writesNothing
              // Both halves of "Only the name is stored" died with the
              // localStorage map: on this branch nothing is written anywhere.
              ? "Nothing here differs from what we read off the wallet, so no transaction is sent."
              : "You sign this yourself. No server can set or raise an agent's limits. Gas for it comes from the demo faucet.")}
        </p>
        {wallet ? null : (
          <Mono size="2xs" tone="faintest" className="px-1 text-center">
            factory {shortAddress(BASE_SEPOLIA_ADDRESSES.agentPbmFactory)}
          </Mono>
        )}
      </div>
    </OverlayScreen>
  );
}

/**
 * What to say about a write that was broadcast and never confirmed.
 *
 * Every branch has the same job: keep the payer from doing the one thing that
 * makes it worse. For a deploy that is creating a duplicate wallet; for an
 * arming it is assuming the agent is either live or dead without looking.
 */
function unresolvedText(
  err: UnknownOutcomeError,
  created: Address | null,
  landed: readonly FormWrite[],
): string {
  // A switch over the closed `WriteName` union, so an eighth write fails to
  // compile here instead of silently taking the policy sentence — which is the
  // bug this function shipped once already.
  switch (err.what) {
    case "createWallet":
      return "The wallet deploy was submitted and we couldn't confirm it in time. It may still land. Check your agents list before trying again. Creating another would deploy a second wallet for the same signer.";
    // Its own branch, because falling through to the policy sentence said the
    // wrong thing twice at once: it reported a write that had ALREADY been
    // confirmed as unresolved, and never mentioned the rename that actually
    // was — then advised re-sending, which would reset the daily counter for a
    // stalled rename.
    case "setLabel":
      return `${landedText(landed)} The rename was submitted and we couldn't confirm it in time. It only changes the display name (the spend rules are unaffected either way), so open the agent and see which name the chain holds before sending it again.`;
    // The one unresolved write where doing nothing is not the safe default. If
    // the rotation was prompted by a leaked key, the old key keeps spending for
    // as long as this stays unresolved — so the advice is to look now.
    case "setAgentSigner":
      return `${landedText(landed)} The session-key rotation was submitted and we couldn't confirm it in time. Open the agent and check which signer the chain holds: if the old key is still there and you were replacing one you don't trust, revoke the policy, which stops every key at once, and rotate afterwards.`;
    case "setPolicy":
      return created
        ? `The wallet is deployed at ${shortAddress(created)} and the policy write was submitted without being confirmed in time. An unarmed wallet can't spend anything, because every authorization reverts, so open it and see what the chain says before sending another.`
        : `${landedText(landed)} The policy write was submitted and we couldn't confirm it in time. Open the agent to see what the chain holds before sending it again.`;
    // This form sends none of these, so reaching them means a caller changed.
    // A true, unspecific sentence rather than a confident wrong one — and the
    // union is what guarantees this list stays complete.
    case "revoke":
    case "withdraw":
    case "setMerchantPayout":
      return `${landedText(landed)} That transaction was submitted and we couldn't confirm it in time. Open the agent and see what the chain holds before sending it again.`;
  }
}

/** The three writes this form can send. A union, not `string`, so a typo in a
 * `landed.push` is a compile error rather than a sentence that renders the raw
 * key ("Your signer is on-chain"). */
type FormWrite = "policy" | "signer" | "name";

/** English for the writes a save sent, in the order it sent them. Three optional
 * transactions make seven combinations, which is well past what a chain of
 * ternaries can state without getting one of them wrong.
 *
 * `plural` is carried per noun because "rules" already IS plural, and agreeing
 * the verb with the LIST LENGTH instead rendered "Your rules is on-chain." on
 * the single most likely partial-failure path. Grammatical number is a property
 * of the word, so it lives with the word. */
const WRITES: Record<FormWrite, { noun: string; plural: boolean }> = {
  policy: { noun: "rules", plural: true },
  signer: { noun: "session key", plural: false },
  name: { noun: "name", plural: false },
};

function writeList(landed: readonly FormWrite[]): string {
  const nouns = landed.map((write) => WRITES[write].noun);
  if (nouns.length <= 1) return nouns[0] ?? "";
  return `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
}

/** The toast after a save that fully succeeded. */
function savedText(landed: readonly FormWrite[]): string {
  const list = writeList(landed);
  // Capitalised here rather than in the map, which is also read mid-sentence.
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} updated on-chain.`;
}

/** What already mined, as a sentence to lead an error with. Empty when nothing
 * did, so callers can prepend it unconditionally. */
function landedText(landed: readonly FormWrite[]): string {
  if (landed.length === 0) return "";
  // A compound subject is always plural; a single one takes its own number.
  const plural = landed.length > 1 || WRITES[landed[0]!].plural;
  return `Your ${writeList(landed)} ${plural ? "are" : "is"} on-chain.`;
}

/**
 * The "expires in" field, prefilled from the wallet.
 *
 * Hardcoding it collapsed a 365-day policy to 30 the moment someone opened the
 * form to add a category. A policy that is revoked or has already lapsed has no
 * date worth preserving, so it falls back to the default rather than prefilling
 * a spent one.
 */
function daysRemaining(existing: AgentSummary | undefined, now: number): string {
  if (!existing) return DEFAULT_DAYS;
  const remaining = Math.ceil((existing.expiry - now) / DAY_SECONDS);
  if (!Number.isFinite(remaining) || remaining < 1) return DEFAULT_DAYS;
  return String(Math.min(remaining, MAX_DAYS));
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.75", className)}>
      <span className="text-key font-medium">{label}</span>
      {children}
      {hint ? <span className="text-fine text-faint">{hint}</span> : null}
    </label>
  );
}

/**
 * A cap the payer typed → the units the contract will store, or null.
 *
 * The same conversion the writer uses, so the two cannot disagree about what a
 * given string means — validating with `Number()` while writing with
 * `parseSgd`/bigint left the accepted decimal places up to two independent
 * parsers.
 */
function capUnits(input: string, rate: bigint): bigint | null {
  const trimmed = input.trim();
  if (!AMOUNT.test(trimmed)) return null;
  try {
    const units = capUnitsFromSgd(trimmed, rate);
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

/** One message at a time, in the order a person fills the form in. */
function validate(input: {
  wallet: Address | null;
  signer: string;
  name: string;
  dailyCap: string;
  perTxCap: string;
  categories: number[];
  days: string;
  rate: bigint | null;
}): string | null {
  if (!input.rate) return "The swap's rate could not be read, so caps cannot be converted yet.";
  // Checked on an existing wallet too, now that the field is editable there.
  // Gated on `!wallet` it validated only the create path, so an edit could send
  // `setAgentSigner` whatever had been typed — and the contract's only guard is
  // against the zero address, which means a valid-but-wrong key silently becomes
  // the only key allowed to spend.
  if (!isAddress(input.signer.trim())) {
    return "The agent signer must be a wallet address.";
  }
  // Checked here rather than left to the chain: `_setLabel` reverts LabelTooLong,
  // and on a create that revert would burn the deploy transaction with it. Bytes,
  // not characters — the contract counts bytes, so this refuses exactly what it
  // refuses (eight 4-byte emoji are already over).
  const labelBytes = labelByteLength(input.name.trim());
  if (labelBytes > LABEL_MAX_BYTES) {
    return `The name is ${labelBytes} bytes and the wallet stores at most ${LABEL_MAX_BYTES}. Emoji cost four bytes each.`;
  }
  const daily = capUnits(input.dailyCap, input.rate);
  if (daily === null) {
    return "The daily cap must be an amount above zero, with at most two decimals.";
  }
  const perTx = capUnits(input.perTxCap, input.rate);
  if (perTx === null) {
    return "The per-payment cap must be an amount above zero, with at most two decimals.";
  }
  // Compared as the CONTRACT will see them: both caps are ceiled into token
  // units before `authorizeSpend` ever compares them.
  if (perTx > daily) {
    return `The per-payment cap cannot exceed the daily cap (${formatUnits6(perTx, 6)} > ${formatUnits6(daily, 6)} USDC).`;
  }
  if (input.categories.length === 0) {
    return "Pick at least one category. An agent allowed nowhere can never spend.";
  }
  if (!/^\d+$/.test(input.days) || Number(input.days) < 1 || Number(input.days) > MAX_DAYS) {
    return `Expiry must be between 1 and ${MAX_DAYS} days.`;
  }
  return null;
}
