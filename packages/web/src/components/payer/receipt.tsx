"use client";

import { useEffect } from "react";
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
import { usePayer } from "./payer-context";

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

function SettledBody({ settlement, at }: { settlement: SettlementEvent; at: number }) {
  const { identity, agentName, chainNow } = usePayer();
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
          <KeyValue label="Paid by">{paidBy(settlement, identity.address, agentName)}</KeyValue>
          <KeyValue label="Transaction" divider={false}>
            <a
              className="focus-ring rounded-badge underline-offset-2 hover:underline"
              href={basescanTx(settlement.txHash)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(settlement.txHash)}
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
          <KeyValue label="Agent">{agentName(denial.wallet) ?? shortAddress(denial.wallet)}</KeyValue>
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
                {shortAddress(denial.cancelTxHash)}
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
  agentName: (wallet: Address) => string | null,
): string {
  if (settlement.bridged) return "via facilitator";
  if (self && settlement.payer.toLowerCase() === self.toLowerCase()) return "You";
  return agentName(settlement.payer) ?? shortAddress(settlement.payer);
}
