"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import {
  agentStatus,
  basescanAddress,
  basescanTx,
  formatUnits6,
  shortAddress,
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
import type { ActivityRow } from "./activity";
import { useAgentWrites, UnknownOutcomeError } from "./agent-writes";
import {
  categoryLabels,
  policyFingerprint,
  REVOKED_FINGERPRINT,
  sgdFromCapUnits,
} from "./agent-rules";
import { calendarDate, relativeWhen, sgdUnits } from "./format";
import { OverlayHeader, OverlayScreen } from "./overlay";
import { usePayer } from "./payer-context";

/**
 * One agent's on-chain allowance, and the two writes that change it.
 *
 * Both writes are signed by the payer: `setPolicy` and `revoke` are `onlyOwner`
 * and the owner is this browser's key, so there is no server route that could
 * override them. That is the claim the screen makes and it has to be literally
 * true — which is why the note under Revoke says so.
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
  const { revoke } = useAgentWrites();
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
  const [busy, setBusy] = useState<string | null>(null);
  /** What the last revoke attempt resolved to. `danger` is a proven failure;
   * `sunken` is everything we cannot call one — a broadcast we could not
   * confirm, or a revoke that landed whose read-back did not. */
  const [notice, setNotice] = useState<{
    tone: "danger" | "sunken";
    text: string;
    txHash?: Hex;
    /** Offer another read of the wallet. Only for an outcome the chain has yet
     * to settle — re-reading a proven failure answers nothing. */
    recheck?: boolean;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);

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

    const read = async (attempt: number) => {
      try {
        const summary = await api.agent(wallet);
        if (cancelled) return;
        setFresh(summary);
        setReadError(null);
        const expected = agentExpectation(wallet);
        if (!expected || policyFingerprint(summary) === expected) {
          // Either nothing was pending, or the read caught up. Both end the wait.
          if (expected) settleAgentExpectation(wallet);
          return;
        }
        if (attempt + 1 >= FRESHNESS_ATTEMPTS) {
          // Give up waiting, but keep rendering what the chain said — the write
          // is mined either way, and a screen frozen on a spinner would be a
          // worse answer than figures that are a moment behind.
          console.warn(`gantry: ${wallet} still reads the previous policy after a confirmed write`);
          settleAgentExpectation(wallet);
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
        settleAgentExpectation(wallet);
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

  const agent = fresh ?? listed;
  const name = agentName(wallet) ?? shortAddress(wallet);

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
   * from a write this browser made and saw MINED, so this is never a
   * disagreement about the chain — it is one source being behind the other.
   */
  const expected = agentExpectation(wallet);
  const superseded = agent !== undefined && expected !== null && policyFingerprint(agent) !== expected;

  const history = useMemo(
    () => rows.filter((row) => belongsToWallet(row, wallet)),
    [rows, wallet],
  );

  if (!agent || superseded) {
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
  const status = agentStatus(agent, chainNow());

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
    setBusy("Revoking on-chain…");
    try {
      await revoke(wallet);
    } catch (err) {
      if (err instanceof UnknownOutcomeError) {
        setConfirming(false);
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
        setNotice({ tone: "danger", text: err instanceof Error ? err.message : String(err) });
      }
      setBusy(null);
      return;
    }

    setConfirming(false);
    toast.success("Agent revoked. Every payment it attempts now reverts.");
    // The revoke is mined, so the zeroed policy is what the chain holds; a read
    // that still shows the old caps is a replica behind, not a disagreement.
    // Recorded before the re-read is triggered so the poll below can see it.
    expectAgentPolicy(wallet, REVOKED_FINGERPRINT);
    refresh();
    // Through the same effect as every other read, rather than a bare `api.agent`
    // here: that one-shot read was itself the too-early one, and it landed
    // beside a status chip that would then keep saying "Active".
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
                {shortAddress(agent.wallet)}
              </a>
            </KeyValue>
            <KeyValue label="Balance">
              {formatUnits6(BigInt(agent.balance), 6)} {agent.token}
            </KeyValue>
            <KeyValue label="Per-payment cap">
              S${sgdFromCapUnits(agent.perTxCap, rate)}
            </KeyValue>
            <KeyValue label="Allowed at" mono={false}>
              {categoryLabels(agent.categories)}
            </KeyValue>
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
            {/* Absent when the bounded log scan did not reach a policy change —
                the wallet stores no timestamp, so there is nothing to fall back
                to and a guess about when someone's spending rules last moved is
                worse than no line at all. */}
            {agent.policyUpdatedAt !== null && (
              <KeyValue label="Rules updated">
                {relativeWhen(agent.policyUpdatedAt, chainNow())}
              </KeyValue>
            )}
            <KeyValue label="Signer" divider={false}>
              {shortAddress(agent.agentSigner)}
            </KeyValue>
          </KeyValueList>
        </Card>
        <p className="px-1 text-fine text-faint">
          Caps are stored in {agent.token}. The S$ figures convert at the swap&apos;s owner-set
          rate of 1 {agent.token} = {formatUnits6(rate, 4)} XSGD.
        </p>

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
                    Check {shortAddress(notice.txHash)} on Basescan
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

        <div className="flex gap-2.5">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => pushOverlay({ kind: "agentForm", wallet })}
            className="focus-ring h-12.5 flex-1 rounded-control-m bg-surface text-btn-sm font-medium text-ink transition-colors hover:bg-fill-hover-card disabled:text-faintest"
          >
            Edit rules
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => (confirming ? void onRevoke() : setConfirming(true))}
            className="focus-ring h-12.5 flex-1 rounded-control-m bg-danger-tint text-btn-sm font-medium text-danger transition-colors hover:bg-danger-tint-hover disabled:text-faintest"
          >
            {busy ?? (confirming ? "Tap again to revoke" : "Revoke")}
          </button>
        </div>
        <p className="px-1 text-center text-fine text-faint">
          Revoking writes to the wallet on-chain, signed by you. Every payment after it reverts, and
          no server can override it.
        </p>
      </div>
    </OverlayScreen>
  );
}

/** A row belongs to an agent when the wallet itself paid, or when the wallet's
 * own policy refused. A human payment by the owner is not the agent's. */
function belongsToWallet(row: ActivityRow, wallet: Address): boolean {
  const needle = wallet.toLowerCase();
  if (row.kind === "denial") return row.denial.wallet.toLowerCase() === needle;
  return row.settlement.payer.toLowerCase() === needle;
}
