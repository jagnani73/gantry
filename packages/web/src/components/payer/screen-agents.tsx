"use client";

import type { Address } from "viem";
import { agentStatus, shortAddress, type AgentSummary } from "@gantry/shared";
import { CapMeter, Card, Chip, Mono } from "@/components/primitives";
import { STATUS_LABEL } from "./agent-detail";
import { categoryLabels, sgdFromCapUnits } from "./agent-rules";
import { usePayer } from "./payer-context";

/**
 * The payer's agents, enumerated from the factory's `WalletCreated` logs.
 *
 * That walk is a block-range scan and can take seconds cold, so `agents === null`
 * renders skeletons rather than "no agents yet" — a payer with three agents
 * being told they have none, for two seconds, on stage, is the failure mode this
 * screen exists to avoid.
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
  const { agents, agentsError, agentsUnreadable, chainNow, agentName, identity, refresh, pushOverlay } =
    usePayer();
  // Without an address there is no owner to enumerate wallets for, so the
  // skeletons would never resolve into anything.
  const noWallet = identity.ready && !identity.address;

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
              Connect a wallet in Settings. An agent is a wallet you own on-chain, so there has to
              be an owner first.
            </p>
          </Card>
        ) : agentsError ? (
          <Card tone="danger" radius="card-m" pad="m">
            <p className="text-body-sm">
              We couldn&apos;t list your agents. Any wallet you own is still on-chain with its
              policy intact. This is the reading, not the rules. Don&apos;t create a new one until
              this loads, or you&apos;ll end up with two.
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
                    You don&apos;t have an agent yet. Creating one deploys a wallet you own and arms
                    it with a spend policy only you can change: two transactions, signed here.
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
              agents.map((agent) => (
                <AgentCard
                  key={agent.wallet}
                  agent={agent}
                  name={agentName(agent.wallet) ?? shortAddress(agent.wallet)}
                  now={chainNow()}
                  onOpen={() => pushOverlay({ kind: "agent", wallet: agent.wallet })}
                />
              ))
            )}
          </>
        )}
      </div>
      {/* The caps below are stored in USDC; the S$ figures are a conversion at
          a rate one address sets on FixedRateSwap. Every screen that shows them
          back has to say so — this is the only place this screen can. */}
      {agents && agents.length > 0 ? (
        <p className="mt-3 px-1 text-fine text-faint">
          Caps are stored in USDC. S$ figures convert at the swap&apos;s owner-set rate.
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
        {wallets.length === 1 ? "1 agent" : `${wallets.length} agents`} could not be read. You own{" "}
        {wallets.length === 1 ? "this wallet" : "these wallets"} on-chain and{" "}
        {wallets.length === 1 ? "its policy is" : "their policies are"} unchanged. This is the
        reading, not the rules. Don&apos;t create a replacement, or you&apos;ll have two for one
        signer.
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

function AgentCard({
  agent,
  name,
  now,
  onOpen,
}: {
  agent: AgentSummary;
  name: string;
  now: number;
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
          <div className="truncate text-card-title">{name}</div>
          <Mono size="2xs" tone="faint" className="mt-1 block">
            {shortAddress(agent.wallet)}
          </Mono>
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
