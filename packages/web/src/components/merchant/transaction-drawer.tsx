"use client";

import { useEffect, useRef } from "react";
import {
  BASE_SEPOLIA_CHAIN_ID,
  GANTRY_FEE_BPS,
  basescanBlock,
  basescanTx,
  formatBps,
  formatUnits6,
  shortAddress,
} from "@gantry/shared";
import { Card, DoorChip, Figure, KeyValue, KeyValueList, Label, Money, Mono } from "@/components/primitives";
import { DOOR_HELP, DOOR_TITLE } from "./door-copy";
import { clockTime, grouped, impliedRate, netOf, shortDate } from "./format";
import { useMerchantContext } from "./merchant-context";

/**
 * One settlement, opened from any row.
 *
 * The privacy rule, restated because this is the screen most likely to break it:
 * for an agent payment the merchant sees the door, the payer address and the
 * amount. It must NEVER show the agent's identity, its spend policy, its caps,
 * its balance or its owner — that lives in the payer app, on the other side of a
 * wall this surface does not cross. The drawer therefore reads only from the
 * settlement event; it never asks `/api/agents` or `/api/denials` anything.
 */
export function TransactionDrawer() {
  const { selected, select } = useMerchantContext();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (selected === null) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") select(null);
    };
    document.addEventListener("keydown", onKey);
    // The drawer is full height and the page behind it is a long table; letting
    // the page scroll under the panel makes the scrim feel like a bug.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [selected, select]);

  if (selected === null) return null;

  const row = selected;
  const net = netOf(row);
  const rate = impliedRate(row);

  return (
    <div className="fixed inset-0 z-40 print:hidden">
      <button
        type="button"
        aria-label="Close settlement details"
        onClick={() => select(null)}
        className="absolute inset-0 animate-overlay-in cursor-pointer bg-ink/28"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settlement details"
        className="absolute inset-y-0 right-0 flex w-full max-w-[468px] animate-drawer-in flex-col bg-surface shadow-drawer"
      >
        <div className="flex items-start justify-between gap-4 border-b border-fill-subtle px-7 pt-6.5 pb-5">
          <div>
            <Label>Settlement</Label>
            <Figure units={row.xsgdOut} size="detail" className="mt-2.5" />
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={() => select(null)}
            aria-label="Close"
            className="focus-ring flex size-8 shrink-0 items-center justify-center rounded-control bg-fill-subtle text-quiet transition-colors hover:bg-fill-hover-strong"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-auto px-7 py-5.5">
          <Card tone="fill" radius="tile" pad="none" className="flex items-center gap-3 px-4 py-3.5">
            <DoorChip door={row.door} variant="tile-36" />
            <div>
              <div className="text-row-title">{DOOR_TITLE[row.door]}</div>
              <div className="mt-0.5 text-meta-sm text-muted">{DOOR_HELP[row.door]}</div>
            </div>
          </Card>

          <KeyValueList>
            <KeyValue label="Time">
              {shortDate(row.blockTime)} · {clockTime(row.blockTime)}
            </KeyValue>
            <KeyValue label="Payer">{shortAddress(row.agentPayer ?? row.payer)}</KeyValue>
            {row.agentPayer ? (
              // A bridged vanilla-x402 payment hops agent → relayer → core, so
              // the address the chain records as payer is ours, not the payer's.
              // Saying so is about the rail; it reveals nothing about the agent.
              <KeyValue label="Settled by" mono={false}>
                Gantry facilitator
              </KeyValue>
            ) : null}
            <KeyValue label="Door" mono={false}>
              {DOOR_TITLE[row.door]}
            </KeyValue>
            {/* Mono, not <Money>: it is one value in a column of mono values,
                and an amount set in sans here breaks the column, not the rule. */}
            <KeyValue label="Amount">S${formatUnits6(BigInt(row.xsgdOut))}</KeyValue>
            <KeyValue label="Transaction">
              <a
                className="focus-ring rounded-badge"
                href={basescanTx(row.txHash)}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddress(row.txHash, 22, 6)} ↗
              </a>
            </KeyValue>
            <KeyValue label="Block">
              <a
                className="focus-ring rounded-badge"
                href={basescanBlock(row.blockNumber)}
                target="_blank"
                rel="noreferrer"
              >
                {grouped(row.blockNumber)} ↗
              </a>
            </KeyValue>
            <KeyValue label="Network">Base Sepolia · {BASE_SEPOLIA_CHAIN_ID}</KeyValue>
            <KeyValue label="Status" mono={false} divider={false}>
              Settled
            </KeyValue>
          </KeyValueList>

          <Card tone="fill" radius="tile" pad="none" className="px-4.5 py-4">
            <div className="text-meta font-medium">Money in, money out</div>
            <div className="mt-3 flex flex-col gap-2.25 text-meta">
              <MoneyLine label="Payer sent">
                <Money
                  variant="token"
                  size="lg"
                  units={row.amountIn}
                  dp={6}
                  suffix={row.tokenSymbol}
                />
              </MoneyLine>
              <MoneyLine label="Swapped at">
                {rate === null ? (
                  "—"
                ) : (
                  <Mono size="md">
                    1 {row.tokenSymbol ?? "token"} = {formatUnits6(rate, 4)} SGD
                  </Mono>
                )}
              </MoneyLine>
              <MoneyLine label={`Gantry fee (${formatBps(GANTRY_FEE_BPS)})`}>
                <Mono size="md">
                  −{formatUnits6(BigInt(row.feeXsgd), 4)} XSGD
                </Mono>
              </MoneyLine>
              <div className="flex justify-between gap-4 border-t border-hairline-strong pt-2.25 font-semibold">
                <span>You received</span>
                <Mono size="md">{formatUnits6(net, 4)} XSGD</Mono>
              </div>
            </div>
            <p className="mt-3 text-fine text-faint">
              The rate is owner-set on FixedRateSwap, not a market quote.
            </p>
          </Card>

          <a
            className="focus-ring w-fit rounded-badge text-body"
            href={basescanTx(row.txHash)}
            target="_blank"
            rel="noreferrer"
          >
            View transaction on Basescan ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function MoneyLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
