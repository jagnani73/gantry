"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import {
  BASE_SEPOLIA_ADDRESSES,
  agentStatus,
  basescanAddress,
  basescanTx,
  formatUnits6,
  shortAddress,
  tokenAddress,
  type AgentStatus,
  type AgentSummary,
} from "@gantry/shared";
import {
  CapMeter,
  Card,
  Chip,
  Figure,
  KeyValue,
  KeyValueList,
  Money,
  Mono,
  useToast,
} from "@/components/primitives";
import { api } from "@/lib/api";
import { describeWriteError } from "@/lib/write-error";
import type { ActivityRow } from "./activity";
import { useAgentWrites, UnknownOutcomeError } from "./agent-writes";
import { categorySplit, policyFingerprint, revokedFingerprint, sgdFromCapUnits } from "./agent-rules";
import { calendarDate, relativeWhen, sgdUnits } from "./format";
import { OverlayHeader, OverlayScreen } from "./overlay";
import { usePayer } from "./payer-context";

/**
 * One agent's on-chain allowance, and the writes that change it.
 *
 * Every one of them is signed by the payer: `setPolicy`, `revoke` and `withdraw`
 * are `onlyOwner` and the owner is this browser's key, so there is no server
 * route that could override them. That is the claim the screen makes and it has
 * to be literally true — which is why the note under Revoke says so.
 *
 * Revoke and withdraw are DIFFERENT actions and the copy must keep them apart:
 * revoking stops the agent spending and moves nothing, so a wallet that is
 * revoked still holds its balance until someone takes it out. Collapsing the two
 * would leave a payer believing a revoke had returned their money.
 */

export const STATUS_LABEL: Record<AgentStatus, string> = {
  active: "Active",
  lapsed: "Expired",
  revoked: "Revoked",
};

/** Sized like the payer store's balance watch, and for the identical reason: a
 * replica behind by a block or two catches up in seconds, and anything still
 * behind after this is not going to be fixed by asking again. */
const FRESHNESS_ATTEMPTS = 6;
const FRESHNESS_POLL_MS = 1_200;

export function AgentDetail({ wallet }: { wallet: Address }) {
  const {
    identity,
    agents,
    agentName,
    agentExpectation,
    settleAgentExpectation,
    expectAgentPolicy,
    chainNow,
    rows,
    refresh,
    popOverlay,
    pushOverlay,
  } = usePayer();
  const { revoke, withdraw } = useAgentWrites();
  const toast = useToast();

  const listed = useMemo(
    () => (agents ?? []).find((a) => a.wallet.toLowerCase() === wallet.toLowerCase()),
    [agents, wallet],
  );
  // Re-read the wallet directly: `spentToday` moves with every payment, and the
  // list behind this screen may be a minute old by the time it is opened.
  const [fresh, setFresh] = useState<AgentSummary | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  /**
   * The freshness poll ran out with the read still behind.
   *
   * It is what lets the screen stop waiting WITHOUT pretending the figures are
   * confirmed. Without it the give-up path settled the expectation and fell
   * straight through to the full detail screen — cap meter, expiry and a status
   * chip — rendering the policy the payer had just replaced as current. After a
   * revoke that produced the exact pair of statements this file exists to
   * prevent: a chip reading "Active" over a wallet that reverts every spend.
   */
  const [waitedOut, setWaitedOut] = useState(false);
  /** Which write is in flight, and what to call it while it is.
   *
   * Carries the action and not just the label because two buttons read this:
   * a bare string put "Withdrawing on-chain…" on the Revoke button, which
   * states that a revoke is under way when none is. */
  const [busy, setBusy] = useState<{ what: "revoke" | "withdraw"; label: string } | null>(null);
  /** What the last write attempt resolved to. `danger` is a proven failure;
   * `sunken` is everything we cannot call one — a broadcast we could not
   * confirm, or a write that landed whose read-back did not. */
  const [notice, setNotice] = useState<{
    tone: "danger" | "sunken";
    text: string;
    txHash?: Hex;
    /** Offer another read of the wallet. Only for an outcome the chain has yet
     * to settle — re-reading a proven failure answers nothing. */
    recheck?: boolean;
  } | null>(null);
  /** Which destructive action is one tap from firing. Two of them share this
   * screen and they must never share a confirmation: arming Revoke and then
   * tapping Withdraw would otherwise fire whichever the flag was last set for. */
  const [confirming, setConfirming] = useState<"revoke" | "withdraw" | null>(null);
  /**
   * A withdraw whose receipt is in hand, before the read agrees.
   *
   * Carries what the receipt actually PROVES, which is narrower than it first
   * appears: `amount` left a wallet that read `before` at the time. It does NOT
   * prove the wallet is now empty — the read behind `before` can be stale-low
   * (a top-up landed, or another visitor of the shared demo key funded it), in
   * which case a remainder survives the withdraw.
   *
   * An earlier version of this pinned the display to ZERO and deliberately
   * never cleared it. That inference was wrong and it failed dangerously: a
   * wallet with a remainder could never satisfy the exit condition, so the
   * override stuck, the Withdraw button vanished (it is gated on a non-zero
   * balance) and the screen told the payer "this wallet holds no USDC" over
   * money that was really there. Hiding funds is a worse outcome than the stale
   * figure this whole mechanism exists to fix.
   */
  const [withdrawal, setWithdrawal] = useState<{ before: bigint; amount: bigint } | null>(null);
  /** Poll attempts, in a ref so counting one does not re-run the effect. */
  const withdrawTries = useRef(0);

  /**
   * Read the wallet, and keep reading while it still shows the policy the payer
   * just replaced.
   *
   * The plain single read is what made a policy update look like it did nothing:
   * the browser confirms its own receipt against one provider and then asks the
   * backend, which uses another, so the read that lands milliseconds later is
   * routinely served by a replica without the block. The payer is returned to
   * this screen showing the caps they just changed. Same lag the payer store's
   * balance watch polls through, and the same discipline — bounded, and it stops
   * the moment the figures actually move.
   *
   * `expected` is only ever set by a write THIS browser made and saw mined, so a
   * mismatch is a stale read and never a disagreement about the chain.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setReadError(null);
    setWaitedOut(false);

    const read = async (attempt: number) => {
      try {
        const summary = await api.agent(wallet);
        if (cancelled) return;
        setFresh(summary);
        setReadError(null);
        const expected = agentExpectation(wallet);
        if (!expected || policyFingerprint(summary) === expected) {
          // Either nothing was pending, or the read caught up. Both end the wait.
          //
          // The summary goes WITH it. This read is proven current — it matches
          // the fingerprint this browser wrote — and it is otherwise invisible
          // outside this component, so settling the flag alone left the agents
          // list unguarded over the row it still held from before the write.
          if (expected) settleAgentExpectation(wallet, summary);
          return;
        }
        if (attempt + 1 >= FRESHNESS_ATTEMPTS) {
          // Stop waiting, and SAY so. The write is mined, so the figures below
          // are behind rather than wrong — but rendering them silently as
          // current is what put an "Active" chip over a revoked wallet.
          console.warn(`gantry: ${wallet} still reads the previous policy after a confirmed write`);
          // No summary, deliberately: this read is the one we have just declared
          // stale, and promoting it into the store would have the agents list
          // state it as fact with none of the caveat this screen shows below.
          settleAgentExpectation(wallet);
          setWaitedOut(true);
          setNotice({
            tone: "sunken",
            text: "Your change is on-chain, but we couldn't read it back just now, so the figures below may be a moment old.",
            recheck: true,
          });
          return;
        }
        timer = setTimeout(() => void read(attempt + 1), FRESHNESS_POLL_MS);
      } catch (err) {
        // When the list has an entry this only costs freshness — but right
        // after creating a wallet the list has NOT caught up, and swallowing
        // this left the screen reading "Reading this agent's policy…" forever
        // with nothing on it saying why.
        if (cancelled) return;
        console.warn(`gantry: agent read failed for ${wallet}`, err);
        setReadError(err instanceof Error ? err.message : String(err));
        // The expectation is deliberately NOT settled. A failed read is not an
        // answer to "did the write land", and settling it here dropped the only
        // signal that the rendered policy is superseded — so one flaky GET fell
        // through to the pre-write caps, with `readError` set but unreachable,
        // since its card only renders inside the wait guard below.
      }
    };

    void read(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `agentExpectation` is read inside and deliberately NOT a dependency: it
    // changes identity the moment this effect settles it, which would restart
    // the very poll that just finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, reloadNonce]);

  /**
   * Re-reads the wallet until it reports the balance the withdraw already took.
   *
   * Separate from the main read effect on purpose: that one waits on
   * `policyFingerprint`, which excludes the balance, so it cannot express this
   * condition. Bounded, and giving up leaves `withdrawn` set — the figure on
   * screen is backed by a receipt either way, so what stops is the asking, not
   * the claim.
   */
  useEffect(() => {
    if (!withdrawal || !fresh) return;
    // ANY movement ends the wait, not a specific figure. The read having
    // changed at all means it now reflects a block at or after the withdraw,
    // so from here the chain's own answer is better than anything derived —
    // including when a top-up has left a remainder the receipt says nothing
    // about.
    if (BigInt(fresh.balance) !== withdrawal.before) {
      setWithdrawal(null);
      return;
    }
    if (withdrawTries.current >= FRESHNESS_ATTEMPTS) {
      // Stop overriding, and SAY so. Falling back to the read can only show a
      // figure that is behind; continuing to assert a computed one can hide
      // money outright, which is the strictly worse failure.
      console.warn(`gantry: ${wallet} still reads its pre-withdraw balance; showing the read`);
      setWithdrawal(null);
      setNotice({
        tone: "sunken",
        text: "Your withdrawal is on-chain, but we couldn't read the new balance back just now, so the figure below may be a moment old.",
        recheck: true,
      });
      return;
    }
    const timer = setTimeout(() => {
      withdrawTries.current += 1;
      // Through the MAIN read effect rather than a second `api.agent` here.
      // Two effects both calling `setFresh` on independent schedules is
      // last-writer-wins over shared state, and the losing order is not
      // theoretical: a lagging withdraw read landing after a revoke's read had
      // settled would restore the pre-revoke snapshot and put an "Active" chip
      // over a revoked wallet — the exact statement this screen exists to
      // prevent. One owner of `fresh`, always.
      setReloadNonce((n) => n + 1);
    }, FRESHNESS_POLL_MS);
    return () => clearTimeout(timer);
  }, [withdrawal, fresh, wallet]);

  const agent = fresh ?? listed;
  // The wallet's own label wins over the list's: this screen's read is the newer
  // of the two. `||` and not `??` — the contract lets a label be "", and an empty
  // string is not a name.
  const name = agent?.label || agentName(wallet) || shortAddress(wallet);

  /**
   * The rules on screen are the ones the payer just replaced.
   *
   * Two sources feed this screen and the fallback is what exposes it: `listed`
   * comes from the store's agent list, which is fetched but not yet back, so the
   * first paint after a save is the OLD policy — and it stays up until the poll
   * above lands, at which point the numbers change under the payer with no
   * explanation. Being shown the caps you just changed, then watching them
   * silently become the ones you asked for, is worse than a wait: the first
   * frame is a claim about the chain, and it is wrong.
   *
   * So known-superseded data is not rendered at all. `expected` is only ever set
   * from a write this browser made and saw MINED, so a mismatch is almost always
   * one source being behind the other rather than a disagreement about the
   * chain. Not ALWAYS: a deployed build signs with one shared demo key and
   * `demo:reset` re-arms wallets, so a concurrent write makes the mismatch
   * genuine and this hides the newer truth for the length of the poll. That is
   * why the poll is bounded and why giving up is visible — do not read this as a
   * licence to wait indefinitely.
   */
  const expected = agentExpectation(wallet);
  const superseded = agent !== undefined && expected !== null && policyFingerprint(agent) !== expected;

  const history = useMemo(
    () => rows.filter((row) => belongsToWallet(row, wallet)),
    [rows, wallet],
  );

  // `waitedOut` is what ends the wait, not the absence of an expectation: the
  // poll settles the expectation as it gives up, so gating on `superseded` alone
  // would let the give-up path render superseded figures as confirmed. Past that
  // point the screen renders, carrying the notice the poll set.
  if (!agent || (superseded && !waitedOut)) {
    return (
      <OverlayScreen>
        <OverlayHeader onBack={popOverlay} backLabel="Back" title={name} />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          {readError === null ? (
            <p className="text-body text-muted">
              {expected !== null
                ? // Named for what it is actually waiting on. The change is
                  // already mined; what has not happened is the read catching
                  // up. Keyed on the expectation rather than on `superseded` so
                  // a freshly created wallet — which has no previous policy to
                  // be superseded — says the same true thing.
                  "Your change is on-chain. Reading it back…"
                : "Reading this agent's policy from the chain…"}
            </p>
          ) : (
            <>
              <p className="text-body text-muted">
                We couldn&apos;t read this agent&apos;s policy. Its limits are on-chain and
                unchanged. This is the reading, not the rules.
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

  const rate = BigInt(agent.rate);
  /**
   * Is this the payer's own agent, or somebody else's?
   *
   * It became a question the moment agents got a URL: `?agent=0x…` takes any
   * well-formed address, and the shape check is the only one the parser can do
   * — ownership is a CHAIN fact, and the parser is pure. So a link could put a
   * stranger's caps, categories, balance and spend history inside this app with
   * Revoke and Withdraw sitting under them.
   *
   * Nothing could be stolen: both writes are `onlyOwner` and revert. The problem
   * is what the screen SAYS. This is the surface whose whole claim is "these are
   * your agent's rules and nobody else can change them", and it was making that
   * claim about wallets the payer has no relationship to.
   *
   * The fix is to gate the CONTROLS, not the route. A policy is public chain
   * state — refusing to display it protects nothing, and anyone can read the same
   * fields off Basescan — so the honest treatment is to show it and stop pretending
   * it is actionable. That is also the rule the denial remedy already follows one
   * layer out: it renders nothing rather than offer a button that can only fail.
   *
   * Free, which is why it is this rather than an ownership lookup: `agent.owner`
   * is already read (it is printed below) and `identity.address` is already in
   * the store, so there is no async gate and no deferred-open path.
   *
   * Gated on `identity.ready`: the signer preference resolves in an effect, so
   * treating "not read yet" as "not yours" would flash a read-only banner over
   * the payer's own agent on every load.
   */
  const mine =
    identity.ready &&
    identity.address !== undefined &&
    identity.address !== null &&
    agent.owner.toLowerCase() === identity.address.toLowerCase();
  /** Only once we KNOW it is not theirs. Unresolved is not a verdict. */
  const readOnly = identity.ready && !mine;
  /**
   * What the wallet holds, as best this browser can know it.
   *
   * While a withdraw is settling that is `before − amount` — what the receipt
   * proves, relative to the figure we withdrew against — and NOT a flat zero,
   * which would be a claim about the whole wallet that no receipt supports.
   * Clamped, because a stale-low `before` can make the subtraction negative and
   * a negative balance is not a thing.
   *
   * EVERY renderer of a balance on this screen must use this, and that is not a
   * style note: the "Balance" row was left reading `agent.balance` directly and
   * the screen then stated two different balances at once, in the seconds right
   * after a withdraw, when the payer is looking hardest.
   */
  const balance = withdrawal
    ? (() => {
        const settled = withdrawal.before - withdrawal.amount;
        return settled > 0n ? settled : 0n;
      })()
    : BigInt(agent.balance);
  const status = agentStatus(agent, chainNow());
  const categories = categorySplit(agent.categories);

  /**
   * Three outcomes, not two.
   *
   * The revoke itself either reverted (proven: nothing changed), landed, or was
   * broadcast and not confirmed in time. The third one must not render red under
   * a chip still reading "Active" — the same `failed`-vs-`unknown` split the pay
   * flow draws, for the same reason.
   *
   * And the read-back afterwards is a REFRESH, not part of the outcome. It used
   * to sit inside the same `try`, so a revoke that landed on-chain followed by
   * one failed GET rendered as a failure and never refreshed — likelier now that
   * that route answers 503 `AgentReadFailed` where it once 404'd.
   */
  const onRevoke = async () => {
    setNotice(null);
    setBusy({ what: "revoke", label: "Revoking on-chain…" });
    try {
      await revoke(wallet);
    } catch (err) {
      if (err instanceof UnknownOutcomeError) {
        setConfirming(null);
        setNotice({
          tone: "sunken",
          text: "Your revoke was submitted and we couldn't confirm it in time. It may still be landing. Don't send it again: only the chain can answer this, and the status above is what it last said.",
          txHash: err.txHash,
          recheck: true,
        });
        // Re-read once now, and offer the payer the same read again: the
        // transaction may well mine while this is on screen, and a frozen
        // "Active" chip beside an unresolved revoke is the worst pair of
        // statements this screen can make.
        setReloadNonce((n) => n + 1);
        refresh();
      } else {
        // Disarm. A proven failure used to leave `confirming` set, so the next
        // SINGLE tap re-fired the action with no second confirmation — and for
        // withdraw that is the entire balance. The unresolved and success paths
        // both clear it; this one was the odd branch out, not a decision.
        setConfirming(null);
        setNotice({ tone: "danger", ...noticeFrom(err) });
      }
      setBusy(null);
      return;
    }

    setConfirming(null);
    // Cleared before the re-read so the poll's own notice is the one that stands.
    // The read-back is a REFRESH, not part of the outcome: the revoke is mined.
    setNotice(null);
    toast.success("Agent revoked. Every payment it attempts now reverts.");
    // The revoke is mined, so the zeroed policy is what the chain holds; a read
    // that still shows the old caps is a replica behind, not a disagreement.
    // Recorded before the re-read is triggered so the poll below can see it.
    // The wallet keeps its label through a revoke, so the expectation carries the
    // one already on-chain rather than claiming the name went too.
    expectAgentPolicy(wallet, revokedFingerprint(agent.label, agent.agentSigner));
    refresh();
    // Through the same effect as every other read, rather than a bare `api.agent`
    // here: that one-shot read was itself the too-early one, and it landed
    // beside a status chip that would then keep saying "Active".
    setReloadNonce((n) => n + 1);
    setBusy(null);
  };

  /**
   * Takes the whole balance back to the owner.
   *
   * The full amount rather than a typed one, and no destination field: the only
   * address allowed to call this is the owner, so the only destination that
   * needs no verification is the owner's own. A free-text `to` on a screen whose
   * whole point is that funds cannot go astray would be the one place in the app
   * a typo loses money outright.
   *
   * Deliberately does NOT set a policy expectation. `policyFingerprint` covers
   * what an owner write can change and NEVER the balance — by design, since the
   * balance moves on its own with every payment, and folding it in would make
   * every other expectation unsatisfiable. So a fingerprint recorded here would
   * match immediately and prove nothing.
   *
   * That is exactly why `withdrawn` exists. Without it the main read effect
   * takes its `!expected` branch, reads ONCE, gets the pre-withdraw figure from
   * a replica that has not seen the block, and never reads again — measured in
   * the browser, where the card sat on the old balance indefinitely while the
   * toast promised it would catch up. Only navigating away and back fixed it.
   */
  const onWithdraw = async () => {
    if (balance === 0n) return;
    setNotice(null);
    setBusy({ what: "withdraw", label: "Withdrawing on-chain…" });
    try {
      await withdraw({
        wallet,
        token: tokenAddress(BASE_SEPOLIA_ADDRESSES, agent.token),
        to: agent.owner,
        amount: balance,
      });
    } catch (err) {
      if (err instanceof UnknownOutcomeError) {
        setConfirming(null);
        setNotice({
          tone: "sunken",
          text: "Your withdrawal was submitted and we couldn't confirm it in time. It may still be landing. Don't send it again before looking: if it did land, a second one asks for a balance the wallet no longer has and simply reverts.",
          txHash: err.txHash,
          recheck: true,
        });
        setReloadNonce((n) => n + 1);
        refresh();
      } else {
        // Disarm. A proven failure used to leave `confirming` set, so the next
        // SINGLE tap re-fired the action with no second confirmation — and for
        // withdraw that is the entire balance. The unresolved and success paths
        // both clear it; this one was the odd branch out, not a decision.
        setConfirming(null);
        setNotice({ tone: "danger", ...noticeFrom(err) });
      }
      setBusy(null);
      return;
    }

    setConfirming(null);
    setNotice(null);
    // Before the re-read, so the settled figure is on screen the instant the
    // toast is. Records what the receipt proves — this amount left a wallet
    // that read this much — rather than a verdict about the wallet.
    withdrawTries.current = 0;
    setWithdrawal({ before: BigInt(agent.balance), amount: balance });
    toast.success(`Withdrawn to ${shortAddress(agent.owner)}.`);
    // The agent's rules are untouched — this moved money, not permissions — so
    // there is nothing to re-arm and nothing to warn about. Just re-read.
    refresh();
    setReloadNonce((n) => n + 1);
    setBusy(null);
  };

  return (
    <OverlayScreen>
      <OverlayHeader onBack={popOverlay} backLabel="Back" title={name} />
      <div className="flex flex-col gap-3.5 px-5 pt-6 pb-11">
        <Card tone="accent" radius="card-m" pad="md">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-label uppercase text-on-accent-muted">Spent today</p>
              <Figure
                units={sgdUnits(BigInt(agent.spentToday), rate)}
                size="detail"
                tone="on-accent"
                className="mt-3"
              />
            </div>
            <Chip tone="on-accent">{STATUS_LABEL[status]}</Chip>
          </div>
          <CapMeter
            spent={agent.spentToday}
            cap={agent.dailyCap}
            tone="on-accent"
            height="md"
            className="mt-4.5"
          />
          {/* The contract's day rolls on block.timestamp / 1 days — UTC — which
              is 08:00 in Singapore, not local midnight. */}
          <p className="mt-2.5 text-meta text-on-accent-body">
            of S${sgdFromCapUnits(agent.dailyCap, rate)} daily cap · resets 08:00 SGT
          </p>
        </Card>

        <Card radius="card-m" pad="none" className="px-5 py-2">
          <KeyValueList>
            <KeyValue label="Wallet">
              <a
                className="focus-ring rounded-badge underline-offset-2 hover:underline"
                href={basescanAddress(agent.wallet)}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddress(agent.wallet)} <span aria-hidden>↗</span>
              </a>
            </KeyValue>
            <KeyValue label="Balance">
              {formatUnits6(balance, 6)} {agent.token}
            </KeyValue>
            <KeyValue label="Per-payment cap">
              S${sgdFromCapUnits(agent.perTxCap, rate)}
            </KeyValue>
            {/* Chips rather than "Food & Beverage · Retail", and both sides of
                the bitmap rather than one. The wallet already knows what it
                will turn away; printing only the allowed half meant an owner
                found out at the till, from a revert. Accent for allowed
                because the chain asserts it; neutral for the rest, which is a
                statement about this build's four categories and not about all
                256 bits — hence the line under it. */}
            <KeyValue label="Allowed at" mono={false}>
              <span className="flex flex-wrap justify-end gap-1.5">
                {categories.allowed.length === 0 ? (
                  <Chip size="sm">None</Chip>
                ) : (
                  categories.allowed.map((label) => (
                    <Chip key={label} size="sm" tone="accent">
                      {label}
                    </Chip>
                  ))
                )}
              </span>
            </KeyValue>
            {categories.denied.length > 0 && (
              <KeyValue label="Turned away" mono={false}>
                <span className="flex flex-wrap justify-end gap-1.5">
                  {categories.denied.map((label) => (
                    <Chip key={label} size="sm">
                      {label}
                    </Chip>
                  ))}
                </span>
              </KeyValue>
            )}
            {/* Through `agentStatus`, exactly like the chip above it. Read
                straight off `expiry === 0` this line disagreed with the chip on
                two branches — a failed read rendered "expired Invalid Date"
                beside a chip saying "Revoked", and a revoked policy with a
                future expiry rendered a live date with no prefix. One card
                cannot hold two verdicts about the same question. */}
            <KeyValue label="Expires">
              {status === "revoked"
                ? "revoked"
                : `${status === "lapsed" ? "expired " : ""}${calendarDate(agent.expiry)}`}
            </KeyValue>
            {/* 0 is a wallet whose policy has never been armed — and also what a
                wallet from the pre-10-Aug factory reports, since it has no such
                getter. Neither has a date to show, so neither gets a line. */}
            {agent.policyUpdatedAt > 0 && (
              <KeyValue label="Rules updated">
                {relativeWhen(agent.policyUpdatedAt, chainNow())}
              </KeyValue>
            )}
            <KeyValue label="Signer" divider={false}>
              {shortAddress(agent.agentSigner)}
            </KeyValue>
          </KeyValueList>
        </Card>
        {agent.ambiguous ? (
          /* The caps above describe ONE of the tokens this wallet holds, and the
             wallet's single daily counter is genuinely adding them together —
             so every spend through it is refused (`agent_currency_mismatch`)
             while the meter above looks healthy. Said here because this is the
             only screen its owner sees, and the refusal reaches the agent's
             operator instead. Anyone can cause it: wallet addresses are public
             and an ERC-20 transfer needs no cooperation. */
          <p className="px-1 text-fine text-faint">
            <span className="text-ink">This wallet holds {agent.heldTokens.join(" and ")}.</span> Its
            policy has one daily counter and one set of caps, so it cannot tell the two apart — the
            figures above are in {agent.token} only, and payments through this agent are refused
            until it holds just one. Withdrawing returns everything to you.
          </p>
        ) : (
          <p className="px-1 text-fine text-faint">
            Caps are stored in {agent.token}. The S$ figures convert at the swap&apos;s owner-set
            rate of 1 {agent.token} = {formatUnits6(rate, 4)} XSGD.
          </p>
        )}
        {/* Two limits stated together, because each one alone misleads. The
            turned-away list is the four kinds of shop this build knows, not a
            complete account of a 256-bit map; and a category is what KIND of
            shop, never WHICH one — the signed authorization carries no payee at
            all, so nothing here is a merchant allowlist and it must not read as
            one. */}
        <p className="px-1 text-fine text-faint">
          The wallet caps how much, when, and what kind of shop — not which shop. Turned away
          lists the categories Gantry knows; a merchant sets its own at registration.
        </p>

        <Card radius="card-m" pad="md">
          <div className="text-card-title-xs">Funds in this wallet</div>
          <div className="mt-3 flex items-end justify-between gap-4">
            <Mono size="md" className="block">
              {formatUnits6(balance, 6)} {agent.token}
            </Mono>
            <span className="text-meta text-faint">
              ≈ S${formatUnits6(sgdUnits(balance, rate))}
            </span>
          </div>
          {/* The distinction the Revoke button below cannot make on its own.
              Revoking zeroes the policy; it moves nothing, so a revoked wallet
              sits on its balance indefinitely and a payer who assumed otherwise
              would never come back for it. */}
          <p className="mt-3 text-meta text-muted">
            This is your money, parked where the agent can reach it under the rules above. Revoking
            stops it spending. It does not send anything back. Withdrawing returns the balance to{" "}
            {shortAddress(agent.owner)}, the address that owns this wallet.
            {/* `withdraw(address token, …)` moves ONE token, so on a wallet
                holding two the sentence above would be read as emptying it and
                would leave the other behind with no hint that it existed. */}
            {agent.ambiguous
              ? ` One token at a time — this withdraws the ${agent.token}; repeat for the rest.`
              : ""}
          </p>
          {balance > 0n && !readOnly ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => (confirming === "withdraw" ? void onWithdraw() : setConfirming("withdraw"))}
              className="focus-ring mt-4 h-12 w-full rounded-control-m bg-fill-hover text-btn-sm font-medium text-ink transition-colors hover:bg-fill-hover-strong disabled:text-faintest"
            >
              {busy?.what === "withdraw"
                ? busy.label
                : confirming === "withdraw"
                  ? `Tap again to withdraw ${formatUnits6(balance, 6)} ${agent.token}`
                  : "Withdraw to my wallet"}
            </button>
          ) : (
            // There is no in-app way to fund an agent wallet — the earlier
            // version of this line sent the payer to "the agent's card on your
            // wallet screen", which does not exist. Funding is a transfer to
            // the wallet address, done outside this app.
            <p className="mt-4 text-meta text-faint">
              Nothing to withdraw. This wallet holds no {agent.token}; funding it means sending
              some to {shortAddress(agent.wallet)}.
            </p>
          )}
        </Card>

        <Card radius="card-m" pad="none" className="px-5 pt-4.5 pb-2.5">
          <div className="text-card-title-xs">Recent spend</div>
          {history.length === 0 ? (
            <p className="py-4 text-body-sm text-muted">This agent has not spent anything yet.</p>
          ) : (
            history.slice(0, 6).map((row) => (
              <button
                key={row.key}
                type="button"
                onClick={() => pushOverlay({ kind: "receipt", row })}
                className="focus-ring flex w-full items-center justify-between gap-3 rounded-row border-b border-paper py-3.25 text-left last:border-b-0"
              >
                <span className="min-w-0">
                  <span className="block truncate text-row-title">{row.handle}</span>
                  <Mono size="2xs" tone="faint" className="mt-0.5 block">
                    {relativeWhen(row.at, chainNow())}
                    {row.kind === "denial" ? " · declined" : ""}
                  </Mono>
                </span>
                <Money
                  units={row.kind === "denial" ? row.denial.xsgdAmount : row.settlement.xsgdOut}
                  prefix="S$"
                  size="sm"
                  strike={row.kind === "denial"}
                  tone={row.kind === "denial" ? "faintest" : "ink"}
                />
              </button>
            ))
          )}
        </Card>

        {notice ? (
          <Card tone={notice.tone} radius="control-m" pad="none" className="px-4.5 py-4">
            <p className={notice.tone === "sunken" ? "text-meta text-muted" : "text-meta"}>
              {notice.text}
            </p>
            {notice.txHash || notice.recheck ? (
              <div className="mt-2 flex flex-col items-start gap-1.5">
                {notice.txHash ? (
                  <a
                    href={basescanTx(notice.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring rounded-badge text-meta text-accent underline-offset-2 hover:underline"
                  >
                    Check {shortAddress(notice.txHash)} on Basescan <span aria-hidden>↗</span>
                  </a>
                ) : null}
                {notice.recheck ? (
                  <button
                    type="button"
                    onClick={() => {
                      setReloadNonce((n) => n + 1);
                      refresh();
                    }}
                    className="focus-ring rounded-badge text-meta text-accent underline-offset-2 hover:underline"
                  >
                    Read this wallet again
                  </button>
                ) : null}
              </div>
            ) : null}
          </Card>
        ) : null}

        {/* Both writes are the OWNER's, so on a wallet the payer does not own the
            row is replaced rather than disabled. A disabled Revoke reads as
            "temporarily unavailable" on a screen where it is permanently not
            theirs, and the honest sentence is shorter than the two buttons. */}
        {readOnly ? (
          <Card tone="sunken" radius="control-m" pad="none" className="px-4 py-3.5">
            <p className="text-meta-sm text-muted">
              This agent belongs to {shortAddress(agent.owner)}, not to the wallet you are signing
              with, so its rules are shown read-only. Only its owner can edit or revoke it — the
              contract enforces that, not this app.
            </p>
          </Card>
        ) : (
        <div className="flex gap-2.5">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => pushOverlay({ kind: "agentForm", wallet })}
            className="focus-ring h-12.5 flex-1 rounded-control-m bg-surface text-btn-sm font-medium text-ink transition-colors hover:bg-fill-hover-card disabled:text-faintest"
          >
            Edit rules
          </button>
          {/*
           * DISABLED when there is nothing to revoke, never removed.
           *
           * `revoke()` does not revert on an already-revoked wallet — it writes
           * the same zeroes again — so nothing stops a second one but this. It
           * would cost gas for no change AND re-stamp `policyUpdatedAt` through
           * the internal path it shares with `setPolicy`, moving "Rules updated"
           * to now for a change that changed nothing.
           *
           * But it must not VANISH, and an earlier version of this removed it.
           * `status` comes from `agent = fresh ?? listed`, which past the
           * give-up branch is data this screen has already told the payer may be
           * behind — and `chainNow()` falls back to the device clock, so a
           * laptop running fast can read a live policy as lapsed. This is the
           * emergency stop for a leaked session key; hiding it on a verdict we
           * have caveated is a far worse trade than the gas of a second revoke.
           * Greyed-out and explained still tells the payer where it is.
           *
           * LAPSED stays enabled, which is not an oversight: expiry being in
           * the past stops spending, but the caps and the category bitmap are
           * still on-chain and still rendered above, and `revoke()` is what
           * clears them.
           */}
          <button
            type="button"
            disabled={busy !== null || status === "revoked"}
            onClick={() => (confirming === "revoke" ? void onRevoke() : setConfirming("revoke"))}
            className="focus-ring h-12.5 flex-1 rounded-control-m bg-danger-tint text-btn-sm font-medium text-danger transition-colors hover:bg-danger-tint-hover disabled:bg-nav-active disabled:text-faintest"
          >
            {/* Only this button's own busy label. `busy ?? …` put the withdraw
                text on the Revoke button, which reads as a revoke in flight. */}
            {busy?.what === "revoke"
              ? busy.label
              : status === "revoked"
                ? "Revoked"
                : confirming === "revoke"
                  ? "Tap again to revoke"
                  : "Revoke"}
          </button>
        </div>
        )}
        {/* Silent while the figures above are known to be behind. Past the
            give-up branch this screen renders a notice saying it could not read
            the wallet back, and a sentence stating the agent's status as fact
            directly under that notice is the two halves of the screen
            disagreeing about how much it knows. */}
        <p className="px-1 text-center text-fine text-faint">
          {waitedOut || fresh === null
            ? "Revoking writes to the wallet on-chain, signed by you. No server can override it."
            : status === "active"
              ? "Revoking writes to the wallet on-chain, signed by you. Every payment after it reverts, and no server can override it."
              : status === "revoked"
                ? "This agent is revoked: every payment it attempts reverts on-chain. Editing its rules arms it again."
                : "This agent's policy has expired, so every payment it attempts reverts. Revoking clears its caps and categories too; editing its rules arms it again."}
        </p>
      </div>
    </OverlayScreen>
  );
}

/**
 * A proven failure, as one sentence.
 *
 * The whole error still goes to the console: shortening is about what the payer
 * reads, never about what is knowable. Rendering `err.message` put sixteen lines
 * of viem — Request Arguments, calldata, a docs URL, a version string — on
 * screen to say that a prompt had been declined.
 */
function noticeFrom(err: unknown): { text: string } {
  console.warn("gantry: agent write failed", err);
  return { text: describeWriteError(err).headline };
}

/** A row belongs to an agent when the wallet itself paid, or when the wallet's
 * own policy refused. A human payment by the owner is not the agent's. */
function belongsToWallet(row: ActivityRow, wallet: Address): boolean {
  const needle = wallet.toLowerCase();
  if (row.kind === "denial") return row.denial.wallet.toLowerCase() === needle;
  return row.settlement.payer.toLowerCase() === needle;
}
