"use client";

import { useEffect, type ReactNode } from "react";
import type { Address } from "viem";
import {
  basescanTx,
  formatUnits6,
  shortAddress,
  type AgentSummary,
  type DenialEvent,
  type MerchantResponse,
  type SettlementEvent,
} from "@gantry/shared";
import { Card, DoorChip, Figure, KeyValue, KeyValueList, Mono } from "@/components/primitives";
import type { ActivityRow } from "./activity";
import { categoryLabels, readDenial } from "./agent-rules";
import { clockTime, effectiveRate, formatRate, relativeWhen } from "./format";
import { MerchantTile } from "./merchant-tile";
import { OverlayHeader, OverlayScreen } from "./overlay";
import { DenialRemedy } from "./denial-remedy";
import { usePayer, type PendingReceiptState } from "./payer-context";

/**
 * A receipt, in two shapes: a payment that settled, and one the payer's own
 * agent was refused.
 *
 * The declined shape is the sharpest thing this app shows, and it has one rule:
 * there is NO reverted transaction. `resolveFailedPbmSettle` catches the wallet's
 * policy revert in simulation and never broadcasts it, so the only transaction
 * that exists is the one that cancelled the intent. Rendering a "reverted tx"
 * hash would be inventing a chain event to make a screen look complete.
 */
export function Receipt({ row }: { row: ActivityRow }) {
  const { merchant, ensureMerchant, popOverlay, pushOverlay } = usePayer();

  useEffect(() => {
    ensureMerchant(row.handle);
  }, [ensureMerchant, row.handle]);

  const record = merchant(row.handle);
  const title = record?.displayName ?? row.handle;
  const declined = row.kind === "denial";

  return (
    <OverlayScreen>
      <OverlayHeader onBack={popOverlay} backLabel="Back" title={declined ? "Declined" : "Receipt"} />
      <div className="flex flex-col gap-3.5 px-5 pt-6 pb-11">
        <Card radius="card-m" pad="md" className="text-center">
          <MerchantTile name={title} size="lg" className="mx-auto" />
          <div className="mt-3.5 text-card-title">{title}</div>
          {record?.location ? (
            <div className="mt-0.75 text-meta-sm text-muted">{record.location}</div>
          ) : null}
          <Figure
            units={declined ? row.denial.xsgdAmount : row.settlement.xsgdOut}
            size="detail"
            className="mt-4.5 justify-center"
          />
          <div className="mt-3 flex justify-center">
            <DoorChip
              door={declined ? "declined" : row.settlement.door}
              variant="pill-lg"
              className="gap-2"
            >
              {declined
                ? "✕ Declined on-chain"
                : row.settlement.door === "agent"
                  ? "AI Paid by your agent"
                  : "QR You scanned the code"}
            </DoorChip>
          </div>
        </Card>

        {row.kind === "denial" ? (
          <DeclinedBody denial={row.denial} at={row.at} record={record} />
        ) : (
          <SettledBody settlement={row.settlement} at={row.at} />
        )}

        <button
          type="button"
          onClick={() => pushOverlay({ kind: "merchant", handle: row.handle })}
          className="focus-ring flex items-center justify-between rounded-card-m bg-surface px-5 py-4.5 text-left transition-colors hover:bg-fill-hover-card"
        >
          <span className="text-card-title-xs font-medium">About this shop</span>
          <span className="text-body-lg text-accent" aria-hidden>
            →
          </span>
        </button>
      </div>
    </OverlayScreen>
  );
}

/**
 * `?receipt=<key>` before — or without — the row behind it.
 *
 * A receipt is the one overlay the URL cannot carry whole: every other kind is
 * an id, and this is an `ActivityRow`. So a link, a refresh or a Back onto a
 * cold page names a row this app may not have fetched, and there are THREE
 * answers rather than two.
 *
 * The two rendered here are the ones that are not a receipt. "Looking" must
 * never be worded as "not found" — that is the same collapse the store's
 * `settlements === null` versus `[]` exists to prevent — and "missing" must
 * never be worded as "this payment does not exist", which is a claim about the
 * CHAIN that nothing on this screen can make: the history is paged, and a payer
 * signing with a connected wallet has a different history from the demo account
 * entirely. What is true is narrower and is what the copy says — it is not in
 * the payments loaded for this account.
 *
 * Same `OverlayScreen`/`OverlayHeader` chrome as every other overlay, because a
 * link that lands here should look like the app rather than like a browser
 * error.
 */
export function PendingReceipt({ receipt }: { receipt: PendingReceiptState }) {
  const { popOverlay, refreshHistory, settlementsError, denialsError, agentsError } = usePayer();
  const looking = receipt.status === "loading";
  /**
   * THREE answers, and the third is the one that had to be added.
   *
   * "Not in this wallet" is a verdict about this wallet's history, and only a
   * COMPLETED read can support it. When a history request failed we have not
   * looked — so a payer following a shared link during a backend blip was told
   * their payment "isn't in this wallet's history" on the strength of a request
   * that never came back. A failed fetch is not evidence a payment does not
   * exist, and this app does not get to imply otherwise on a receipt screen.
   *
   * The failure used to appear only as a qualifying paragraph three lines under
   * a headline that had already stated the opposite. On a phone the title and
   * the bold line are what get read.
   */
  const unavailable = receipt.status === "unavailable";
  const failure = settlementsError ?? denialsError ?? agentsError;

  return (
    <OverlayScreen>
      <OverlayHeader
        onBack={popOverlay}
        backLabel="Back"
        title={looking ? "Receipt" : unavailable ? "Couldn’t read this history" : "Not in this wallet"}
      />
      <div className="flex flex-col gap-3.5 px-5 pt-6 pb-11">
        <Card radius="card-m" pad="md">
          <p className="text-card-title-xs">
            {looking
              ? "Looking for this receipt"
              : unavailable
                ? "We couldn’t finish reading this wallet’s history"
                : "That payment isn’t in this wallet’s history"}
          </p>
          <p className="mt-2 text-body-sm text-quiet">
            {looking
              ? "Reading this wallet’s payments and refusals. A receipt opened from a link has to be found in that history before it can be shown."
              : unavailable
                ? "So we can’t say whether this payment is in it. Nothing here means the payment did or didn’t happen — only that the history request failed. Try again below."
                : "It isn’t among the payments loaded for this account — which is not the same as it never having happened. This app reads the most recent page of history, so an older payment may simply not be loaded here, and a receipt made while signing with a different wallet belongs to that wallet’s history rather than this one."}
          </p>
          {!looking && failure ? (
            <p className="mt-3 text-body-sm text-quiet">
              {unavailable ? "The history request failed:" : "One of the history requests also failed, so what was loaded is incomplete:"}{" "}
              <span className="font-mono text-mono-sm break-all text-faint">{failure}</span>
            </p>
          ) : null}
          {/* The key verbatim, because it is the only thing the payer can
              compare against the link they followed. `breakAll` for the same
              reason a 66-character hash gets it everywhere else in this app. */}
          <Mono size="3xs" tone="faint" breakAll className="mt-4 block">
            {receipt.key}
          </Mono>
          {!looking ? (
            <button
              type="button"
              onClick={refreshHistory}
              className="focus-ring mt-4 h-12 w-full rounded-control-m bg-ink text-btn-sm text-paper transition-colors hover:bg-ink-hover"
            >
              Read the history again
            </button>
          ) : null}
        </Card>
      </div>
    </OverlayScreen>
  );
}

function SettledBody({ settlement, at }: { settlement: SettlementEvent; at: number }) {
  const { identity, agents, agentName, chainNow } = usePayer();
  const spender = paidBy(settlement, identity.address, agents, agentName);
  const amountIn = BigInt(settlement.amountIn);
  const gross = BigInt(settlement.xsgdOut);
  const netToShop = gross - BigInt(settlement.feeXsgd);
  // Derived from this row's own two amounts rather than read live: today's
  // owner-set rate is the wrong number for a payment made yesterday, and these
  // are the figures printed directly above it.
  const rate = effectiveRate(amountIn, gross);

  return (
    <>
      <Card radius="card-m" pad="none" className="px-5 py-2">
        <KeyValueList>
          <KeyValue label="Paid">{relativeWhen(at, chainNow())}</KeyValue>
          <KeyValue label="You sent">
            {formatUnits6(amountIn, 6)} {settlement.tokenSymbol ?? "tokens"}
          </KeyValue>
          <KeyValue label="Shop received">{formatUnits6(netToShop)} XSGD</KeyValue>
          {/* Both halves or neither. `rate` is XSGD per 1e6 units of THIS
              settlement's token, so a fixed ticker here reported a euro payment
              at a dollar rate; and an unknown token leaves the figure with no
              unit at all, which is worse than omitting it — the same "absent
              beats wrong" rule `paidToken` follows on the order confirmation. */}
          {rate === null || settlement.tokenSymbol === null ? null : (
            <KeyValue label="Rate">
              1 {settlement.tokenSymbol} = {formatRate(rate)}
            </KeyValue>
          )}
          <KeyValue label="Network fee" mono={false}>
            <span className="text-accent">0.00 · sponsored</span>
          </KeyValue>
          <KeyValue label="Paid by">
            {spender.agent ? (
              <AgentLink wallet={spender.agent}>{spender.text}</AgentLink>
            ) : (
              spender.text
            )}
          </KeyValue>
          <KeyValue label="Transaction" divider={false}>
            <a
              className="focus-ring rounded-badge underline-offset-2 hover:underline"
              href={basescanTx(settlement.txHash)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(settlement.txHash)} <span aria-hidden>↗</span>
            </a>
          </KeyValue>
        </KeyValueList>
      </Card>
      <p className="px-1 text-fine text-faint">
        The shop is paid in XSGD, a testnet mock. XSGD exists on no testnet. The rate is set by the
        swap&apos;s owner, not sourced from a market.
      </p>
    </>
  );
}

function DeclinedBody({
  denial,
  at,
  record,
}: {
  denial: DenialEvent;
  at: number;
  record: MerchantResponse | null | undefined;
}) {
  const { agents, agentName, chainNow } = usePayer();
  const agent = findAgent(agents, denial.wallet);
  const merchantCategory = record ? categoryLabels([record.categoryName]) : undefined;
  const reading = readDenial(denial, agent, merchantCategory);

  return (
    <>
      <Card tone="danger" radius="card-m" pad="none" className="px-5.5 py-5">
        <p className="text-card-title-xs">Your agent tried, the contract said no</p>
        {/* Verbatim, exactly as the revert named it. The sentence underneath
            explains it; it never stands in for it. */}
        <Mono size="sm" className="mt-2.5 block text-danger">
          {denial.errorName}
        </Mono>
        <p className="mt-2 text-body-sm">{reading.explanation}</p>
        <p className="mt-3 text-meta-sm text-danger">
          The wallet reverted the payment on-chain. No money moved, and no server was asked. The
          rule is the contract.
        </p>
      </Card>

      <DenialRemedy denial={denial} agent={agent} record={record} />

      <Card radius="card-m" pad="none" className="px-5 py-2">
        <KeyValueList>
          <KeyValue label="Attempted">{relativeWhen(at, chainNow())}</KeyValue>
          <KeyValue label="Amount">S${formatUnits6(BigInt(denial.xsgdAmount))}</KeyValue>
          {/* Always linkable: `IntentDenied` carries the POLICY WALLET, so this
              address is an AgentPBMWallet by construction even when it is not
              one of ours — and the detail screen reads a stranger's policy
              perfectly well, showing it without the controls (F16). */}
          <KeyValue label="Agent">
            <AgentLink wallet={denial.wallet}>
              {agentName(denial.wallet) ?? shortAddress(denial.wallet)}
            </AgentLink>
          </KeyValue>
          <KeyValue label="Merchant category">{merchantCategory ?? "Unknown"}</KeyValue>
          <KeyValue label="Rule that stopped it">{reading.rule}</KeyValue>
          <KeyValue label="Moved" mono={false}>
            Nothing
          </KeyValue>
          {/* Not "Reverted tx" — the revert never left the simulator. The cancel
              is the only transaction this attempt produced, and when even that
              failed there is no hash to show rather than a plausible one. */}
          {denial.cancelTxHash ? (
            <KeyValue label="Cancelled" divider={false}>
              <a
                className="focus-ring rounded-badge underline-offset-2 hover:underline"
                href={basescanTx(denial.cancelTxHash)}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddress(denial.cancelTxHash)} <span aria-hidden>↗</span>
              </a>
            </KeyValue>
          ) : (
            <KeyValue label="Cancelled" divider={false} mono={false}>
              The cancel did not land, so the intent expires on its own
            </KeyValue>
          )}
        </KeyValueList>
      </Card>
      <p className="px-1 text-fine text-faint">
        Recorded at {clockTime(at)}. Nothing was mined, so this attempt has no block. The only
        transaction it produced is the cancel.
      </p>
    </>
  );
}

/**
 * The agent a receipt names, as a way of getting to it.
 *
 * The receipt states which agent spent and then leaves the payer to go and find
 * it — back out, open the agents tab, pick it from a list — while holding the
 * wallet address the whole time. `?agent=` already addresses that screen, so the
 * name is the link.
 *
 * A BUTTON, not an anchor. This pushes an overlay onto the route the payer is
 * already on, which is what `pushOverlay` owns; an `<a href>` would be a router
 * navigation, and a navigation racing the provider's own URL write-back is the
 * documented way to cancel it (see the tab-bar rule in `payer-context`).
 * Opening pushes, so Back returns to this receipt rather than out of it.
 *
 * `›` and not `↗`: the arrow is this app's mark for an EXTERNAL link, and every
 * Basescan row on this same screen carries one. Using it here would promise a
 * new tab.
 */
function AgentLink({ wallet, children }: { wallet: Address; children: ReactNode }) {
  const { pushOverlay } = usePayer();
  return (
    <button
      type="button"
      onClick={() => pushOverlay({ kind: "agent", wallet })}
      className="focus-ring rounded-badge underline-offset-2 hover:underline"
    >
      {children} <span aria-hidden>›</span>
    </button>
  );
}

export function findAgent(
  agents: readonly AgentSummary[] | null,
  wallet: Address,
): AgentSummary | undefined {
  return (agents ?? []).find(
    (candidate) => candidate.wallet.toLowerCase() === wallet.toLowerCase(),
  );
}

/**
 * Who spent the money, from the payer's point of view.
 *
 * A bridged x402 payment's on-chain payer is the RELAYER — naming it would
 * credit our own key for the agent's purchase — so the hop is labelled instead.
 * The buyer's own address is not an option: it exists nowhere on-chain, which is
 * precisely why the hop happened.
 */
function paidBy(
  settlement: SettlementEvent,
  self: Address | null,
  agents: readonly AgentSummary[] | null,
  agentName: (wallet: Address) => string | null,
): { text: string; agent: Address | null } {
  if (settlement.bridged) return { text: "via facilitator", agent: null };
  if (self && settlement.payer.toLowerCase() === self.toLowerCase()) {
    return { text: "You", agent: null };
  }
  return {
    text: agentName(settlement.payer) ?? shortAddress(settlement.payer),
    /* Linked only when this address is a wallet we KNOW is an agent. Unlike a
       denial, a settlement's payer is not always a policy wallet: a vanilla
       x402 client that pins its own nonce settles as a plain EOA, and the agent
       screen opened on one would sit there reading a policy that does not
       exist. Absent beats wrong, so an unrecognised payer stays plain text. */
    agent: findAgent(agents, settlement.payer) ? settlement.payer : null,
  };
}
