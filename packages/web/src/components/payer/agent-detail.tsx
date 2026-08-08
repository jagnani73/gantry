"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import {
  agentStatus,
  basescanAddress,
  formatUnits6,
  shortAddress,
  type AgentStatus,
  type AgentSummary,
} from "@gantry/shared";
import { CapMeter, Card, Chip, Figure, KeyValue, KeyValueList, Money, Mono } from "@/components/primitives";
import { api } from "@/lib/api";
import type { ActivityRow } from "./activity";
import { useAgentWrites } from "./agent-writes";
import { categoryLabels, sgdFromCapUnits } from "./agent-rules";
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

export function AgentDetail({ wallet }: { wallet: Address }) {
  const { agents, agentName, chainNow, rows, refresh, popOverlay, pushOverlay } = usePayer();
  const { revoke } = useAgentWrites();

  const listed = useMemo(
    () => (agents ?? []).find((a) => a.wallet.toLowerCase() === wallet.toLowerCase()),
    [agents, wallet],
  );
  // Re-read the wallet directly: `spentToday` moves with every payment, and the
  // list behind this screen may be a minute old by the time it is opened.
  const [fresh, setFresh] = useState<AgentSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .agent(wallet)
      .then((summary) => {
        if (!cancelled) setFresh(summary);
      })
      .catch(() => {
        // The list entry is still a real chain read, just an older one.
      });
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const agent = fresh ?? listed;
  const name = agentName(wallet) ?? shortAddress(wallet);

  const history = useMemo(
    () => rows.filter((row) => belongsToWallet(row, wallet)),
    [rows, wallet],
  );

  if (!agent) {
    return (
      <OverlayScreen>
        <OverlayHeader onBack={popOverlay} backLabel="Back" title={name} />
        <div className="flex flex-1 items-center justify-center px-8">
          <p className="text-body text-muted">Reading this agent&apos;s policy from the chain…</p>
        </div>
      </OverlayScreen>
    );
  }

  const rate = BigInt(agent.rate);
  const status = agentStatus(agent, chainNow());
  const live = status === "active";

  const onRevoke = async () => {
    setError(null);
    setBusy("Revoking on-chain…");
    try {
      await revoke(wallet);
      setConfirming(false);
      setFresh(await api.agent(wallet));
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
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
            <KeyValue label="Expires">
              {agent.expiry === 0
                ? "revoked"
                : `${live ? "" : "expired "}${calendarDate(agent.expiry)}`}
            </KeyValue>
            <KeyValue label="Signer" divider={false}>
              {shortAddress(agent.agentSigner)}
            </KeyValue>
          </KeyValueList>
        </Card>
        <p className="px-1 text-fine text-faint">
          Caps are stored in {agent.token} — the S$ figures convert at the swap&apos;s owner-set
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

        {error ? (
          <Card tone="danger" radius="control-m" pad="none" className="px-4.5 py-4">
            <p className="text-meta">{error}</p>
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
          Revoking writes to the wallet on-chain, signed by you. Every payment after it reverts — no
          server can override it.
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
