"use client";

import { useMemo, useState } from "react";
import type { Address } from "viem";
import { agentStatus, shortAddress, type AgentSummary } from "@gantry/shared";
import { CapMeter, Card, Chip, Mono } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { STATUS_LABEL } from "./agent-detail";
import { categoryLabels, sgdFromCapUnits } from "./agent-rules";
import { usePayer } from "./payer-context";

/**
 * Live agents versus the ones that can no longer spend, plus everything.
 *
 * "Inactive" covers BOTH revoked and lapsed, and that grouping is the whole
 * point: `agentStatus` is tri-state because a policy that merely ran out denies
 * every spend while `revoked` stays false, so a filter keyed on the `revoked`
 * flag would leave an expired agent sitting in the Active tab claiming a daily
 * cap it cannot honour. Split by what the wallet will DO, not by which field is
 * set.
 *
 * `All` is listed first to match the Transactions door filter — one tab idiom
 * in the app, not two — but **Active is the default**, which is the one place
 * this deliberately differs. A revoked agent is history and the question this
 * screen answers is "what can spend for me"; landing on All would put dead
 * wallets in front of that answer. The counts sit in the labels so nothing is
 * hidden by the choice.
 */
type AgentTab = "all" | "active" | "inactive";

/**
 * The payer's agents, read from the factory's `walletsOf` view.
 *
 * Two RPC calls — the view, then one multicall of the getters — so this is
 * cheap enough to re-read on a live tick while the screen is open, which is what
 * keeps the cap meters moving as an agent spends. It is not instant, though, and
 * a cold hotspot makes it slower still: `agents === null` renders skeletons
 * rather than "no agents yet", because a payer with three agents being told they
 * have none, for two seconds, on stage, is the failure mode this screen exists
 * to avoid.
 *
 * The error branch is checked FIRST for the same reason and with higher stakes:
 * a failed enumeration also arrives as an empty list, and "You don't have an
 * agent yet" beside a Create button is an invitation to deploy a SECOND wallet
 * for the same signer — the exact state `demo-reset` exists to detect.
 *
 * `agentsUnreadable` is the per-wallet version of that same hazard and gets the
 * same treatment: those wallets hold code and did not answer, so they may well
 * be agents. While any are listed, the empty state and its Create button are
 * replaced by a notice that names them and offers a retry instead.
 */
export function AgentsScreen() {
  const {
    agents,
    agentsError,
    agentsUnreadable,
    chainNow,
    agentAhead,
    identity,
    refresh,
    pushOverlay,
  } = usePayer();
  // Without an address there is no owner to enumerate wallets for, so the
  // skeletons would never resolve into anything.
  const noWallet = identity.ready && !identity.address;
  const [tab, setTab] = useState<AgentTab>("active");

  const now = chainNow();
  const split = useMemo(() => {
    const active: AgentSummary[] = [];
    const inactive: AgentSummary[] = [];
    for (const agent of agents ?? []) {
      (agentStatus(agent, now) === "active" ? active : inactive).push(agent);
    }
    return { active, inactive };
  }, [agents, now]);
  /**
   * The tab actually in force, which is not always the one that was tapped.
   *
   * The strip only renders while something is inactive, and `tab` outlives it:
   * re-arming the LAST inactive agent — the flow the re-arming copy actively
   * encourages — takes the strip off screen with `tab` still on "inactive",
   * leaving the payer on "Nothing here" with no control to get back and their
   * agents apparently gone. Clamped on render rather than reset in an effect,
   * so there is no frame in which the wrong list is painted.
   */
  const effectiveTab: AgentTab = split.inactive.length === 0 ? "all" : tab;
  const shown =
    effectiveTab === "all"
      ? (agents ?? [])
      : effectiveTab === "active"
        ? split.active
        : split.inactive;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-screen-title">My agents</h1>
        <button
          type="button"
          aria-label="Add an agent"
          onClick={() => pushOverlay({ kind: "agentForm", wallet: null })}
          className="focus-ring flex size-8.5 items-center justify-center rounded-nav bg-surface text-title-sm text-quiet transition-colors hover:bg-fill-hover-card"
        >
          +
        </button>
      </div>
      <p className="mt-2 text-body-sm text-muted">
        Software that can spend on your behalf, inside limits you set on-chain. Not even Gantry can
        raise them.
      </p>

      <div className="mt-4.5 flex flex-col gap-2.5">
        {noWallet ? (
          <Card radius="card-m" pad="m">
            <p className="text-body-sm text-muted">
              Connect a wallet in Settings first. An agent is a wallet you own.
            </p>
          </Card>
        ) : agentsError ? (
          <Card tone="danger" radius="card-m" pad="m">
            <p className="text-body-sm">
              We couldn&apos;t list your agents. Your wallets and their policies are unchanged.
              Don&apos;t create a new one until this loads, or you&apos;ll have two.
            </p>
            <p className="mt-2.5 text-meta-sm break-words">{agentsError}</p>
            <button
              type="button"
              onClick={refresh}
              className="focus-ring mt-4 h-12 w-full rounded-control-m bg-ink text-btn-sm text-paper transition-colors hover:bg-ink-hover"
            >
              Try again
            </button>
          </Card>
        ) : agents === null ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            {agentsUnreadable.length > 0 ? (
              <UnreadableNotice
                wallets={agentsUnreadable}
                onRetry={refresh}
                onOpen={(wallet) => pushOverlay({ kind: "agent", wallet })}
              />
            ) : null}
            {agents.length === 0 ? (
              // Only when nothing is unreadable. "You have none" and "one of them
              // did not answer" are opposite facts, and this branch is the one
              // that hands the payer a button that deploys a wallet.
              agentsUnreadable.length === 0 ? (
                <Card radius="card-m" pad="m">
                  <p className="text-body-sm text-muted">
                    No agents yet. Creating one deploys a wallet you own and arms its policy. Two
                    transactions, signed here.
                  </p>
                  <button
                    type="button"
                    onClick={() => pushOverlay({ kind: "agentForm", wallet: null })}
                    className="focus-ring mt-4 h-12 w-full rounded-control-m bg-ink text-btn-sm text-paper transition-colors hover:bg-ink-hover"
                  >
                    Create an agent
                  </button>
                </Card>
              ) : null
            ) : (
              <>
                {/* Only once there is something to separate. One tab holding
                    everything is a control that answers a question nobody has
                    yet, and it costs the demo a row of chrome above the single
                    agent the whole beat is about. */}
                {split.inactive.length > 0 ? (
                  <div
                    role="group"
                    aria-label="Filter agents"
                    className="flex gap-1.5 rounded-nav bg-surface p-1"
                  >
                    <TabButton
                      selected={effectiveTab === "all"}
                      count={agents.length}
                      onClick={() => setTab("all")}
                    >
                      All
                    </TabButton>
                    <TabButton
                      selected={effectiveTab === "active"}
                      count={split.active.length}
                      onClick={() => setTab("active")}
                    >
                      Active
                    </TabButton>
                    <TabButton
                      selected={effectiveTab === "inactive"}
                      count={split.inactive.length}
                      onClick={() => setTab("inactive")}
                    >
                      Inactive
                    </TabButton>
                  </div>
                ) : null}
                {shown.length === 0 ? (
                  <Card radius="card-m" pad="m">
                    {/* `all` is unreachable here — an empty list is caught by
                        the branch above, which is the one that offers to
                        create a wallet — but it is written out rather than
                        left to a fallback, so a future tab cannot inherit
                        someone else's sentence. */}
                    {/* Qualified whenever a wallet could not be read. These are
                        absolute claims over a set the screen has just admitted
                        is incomplete — the notice above says those wallets may
                        well be spending — and the counts in the tabs have the
                        same shape. Same rule as the list-level empty state, one
                        level down. */}
                    <p className="text-body-sm text-muted">
                      {effectiveTab === "active"
                        ? agentsUnreadable.length > 0
                          ? "None of the agents we could read can spend right now. Unreadable ones aren't counted."
                          : "No agent can spend right now. The ones under Inactive were revoked or have expired; opening one and editing its rules arms it again."
                        : effectiveTab === "inactive"
                          ? "Nothing here. Every agent you own can still spend."
                          : "No agents to show."}
                    </p>
                  </Card>
                ) : (
                  shown.map((agent) => (
                    <AgentCard
                      key={agent.wallet}
                      agent={agent}
                      name={agent.label || shortAddress(agent.wallet)}
                      now={now}
                      ahead={agentAhead(agent.wallet)}
                      onOpen={() => pushOverlay({ kind: "agent", wallet: agent.wallet })}
                    />
                  ))
                )}
              </>
            )}
          </>
        )}
      </div>
      {/* The caps are stored in each agent's OWN token; the S$ figures are a
          conversion at a rate one address sets on FixedRateSwap. Every screen
          that shows them back has to say so — this is the only place this one
          can. Naming a single token here was right while there was only one,
          and became a lie about a euro agent's limits the moment there were
          two, so the sentence follows what this payer actually owns. */}
      {agents && agents.length > 0 ? (
        <p className="mt-3 px-1 text-fine text-faint">
          {capTokenNote(agents)} S$ figures convert at the swap&apos;s owner-set rate.
        </p>
      ) : null}
      <div className="h-3" />
    </>
  );
}

/**
 * Wallets the payer owns that hold code and did not answer the read.
 *
 * Deliberately not phrased as an error: nothing is wrong with the wallet, its
 * policy is on-chain and unchanged, and the only thing that failed is this
 * screen's reading of it. What it must never do is let the payer conclude they
 * have no agent — so the retry is the offered action, and each address opens the
 * detail screen, which reads that one wallet on its own and may well succeed
 * where the batch did not.
 */
function UnreadableNotice({
  wallets,
  onRetry,
  onOpen,
}: {
  wallets: Address[];
  onRetry: () => void;
  onOpen: (wallet: Address) => void;
}) {
  return (
    <Card tone="sunken" radius="card-m" pad="m">
      <p className="text-body-sm text-muted">
        {wallets.length === 1 ? "1 agent" : `${wallets.length} agents`} could not be read.{" "}
        {wallets.length === 1 ? "Its policy is" : "Their policies are"} unchanged. Don&apos;t
        create a replacement, or you&apos;ll have two for one signer.
      </p>
      <div className="mt-3.5 flex flex-col gap-1">
        {wallets.map((wallet) => (
          <button
            key={wallet}
            type="button"
            onClick={() => onOpen(wallet)}
            className="focus-ring flex items-center justify-between gap-3 rounded-row py-1.5 text-left"
          >
            <Mono size="2xs" tone="faint">
              {shortAddress(wallet)}
            </Mono>
            <span className="text-body-sm text-hint" aria-hidden>
              ›
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="focus-ring mt-4 h-12 w-full rounded-control-m bg-ink text-btn-sm text-paper transition-colors hover:bg-ink-hover"
      >
        Try again
      </button>
    </Card>
  );
}

/** Matches the Transactions door filter, which is the app's other tab strip —
 * one idiom, not two. The count rides in the label because the reason to look
 * at the other tab is that something is over there. */
function TabButton({
  selected,
  count,
  onClick,
  children,
}: {
  selected: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "focus-ring rounded-chip-sm px-3.5 py-1.75 text-meta transition-colors",
        selected ? "bg-fill-subtle text-ink" : "text-muted hover:text-ink",
      )}
    >
      {children} {count}
    </button>
  );
}

/*
 * The reconciliation this screen used to do lives in the store now — `agents`
 * arrives already carrying what a mined receipt proves, so there is nothing to
 * merge here and nothing for the next screen to forget. See `agents` in
 * `payer-context`.
 *
 * What was here before rendered `Saving…` in place of the name for as long as
 * the read stayed behind, which was wrong twice over: the save had already
 * finished — it is the READ that is late — and nothing bounded the wait, because
 * the give-up rule lives with whoever polls, and the store's live tick — which
 * is the only poll behind this screen — waits on no write and so gives up on
 * nothing.
 */

function AgentCard({
  agent,
  name,
  now,
  ahead,
  onOpen,
}: {
  agent: AgentSummary;
  name: string;
  now: number;
  /** This row is what a mined receipt proves, ahead of what the backend has read
   * back. Everything on it is true of the chain; only its provenance differs. */
  ahead: boolean;
  onOpen: () => void;
}) {
  // Never derived from `revoked` alone: a policy that simply ran out denies
  // every spend while `revoked` stays false, and calling that "Active" is a
  // console that contradicts the agent standing next to it.
  const status = agentStatus(agent, now);
  const live = status === "active";
  const rate = BigInt(agent.rate);

  return (
    <Card as="button" radius="card-m" pad="m" hover onClick={onOpen} className="w-full text-left">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Known-stale text is still never rendered — but the answer is the
              new value, not a placeholder. The browser watched the block; it
              does not need a replica's agreement to name what is in it. */}
          <div className="truncate text-card-title">{name}</div>
          <Mono size="2xs" tone="faint" className="mt-1 block">
            {shortAddress(agent.wallet)}
          </Mono>
          {/* Said, not implied. These figures are true and their provenance is
              a receipt rather than a read, and a payer comparing this screen
              against Basescan in the next few seconds may see the older one.
              It disappears on its own the moment the two agree. */}
          {ahead ? (
            <div className="mt-1 text-fine text-faint">Just changed · reading it back</div>
          ) : null}
        </div>
        <Chip tone={live ? "accent" : "danger"}>{STATUS_LABEL[status]}</Chip>
      </div>
      <CapMeter
        spent={agent.spentToday}
        cap={agent.dailyCap}
        tone={live ? "accent" : "danger"}
        className="mt-4"
      />
      <div className="mt-2.5 flex items-baseline justify-between gap-3">
        <span className="text-meta text-muted">
          S${sgdFromCapUnits(agent.spentToday, rate)} of S${sgdFromCapUnits(agent.dailyCap, rate)}{" "}
          today
        </span>
        <span className="truncate text-meta-sm text-faint">{categoryLabels(agent.categories)}</span>
      </div>
    </Card>
  );
}

function SkeletonCard() {
  return (
    <Card radius="card-m" pad="m" aria-hidden>
      <div className="h-4 w-2/5 rounded-badge bg-fill-subtle" />
      <div className="mt-2.5 h-3 w-1/3 rounded-badge bg-fill-subtle" />
      <div className="mt-4.5 h-1.25 w-full rounded-full bg-fill-subtle" />
      <div className="mt-3 h-3 w-1/2 rounded-badge bg-fill-subtle" />
    </Card>
  );
}

/**
 * How to describe where these caps are denominated, given what this payer owns.
 *
 * An agent's cap is a single number in its own token's units, so with two
 * currencies on screen there is no single token to name. Saying "each agent's
 * own" is vaguer than naming one and is the only version that is true of both
 * rows; when they agree, the specific answer is better and is still available.
 */
function capTokenNote(agents: AgentSummary[]): string {
  const tokens = [...new Set(agents.map((a) => a.token))];
  return tokens.length === 1
    ? `Caps are stored in ${tokens[0]}.`
    : "Caps are stored in each agent's own token.";
}
