"use client";

import { shortAddress, type SettlementEvent } from "@gantry/shared";
import { DoorChip, Money, Mono, Row } from "@/components/primitives";
import { DOOR_TITLE } from "./door-copy";
import { clockTime } from "./format";

/**
 * One line of the live feed.
 *
 * The address shown is `agentPayer ?? payer`: when the facilitator bridged a
 * vanilla x402 payment the on-chain payer is the relayer, and printing the
 * relayer on every agent row would tell a merchant that the same customer paid
 * fourteen times. That is the x402 payer's address and nothing more — no agent
 * identity, no policy, no balance, none of which this surface ever sees.
 */
export function SettlementFeedRow({
  row,
  fresh,
  onOpen,
}: {
  row: SettlementEvent;
  fresh: boolean;
  onOpen(): void;
}) {
  return (
    <Row
      interactive
      highlight={fresh}
      onClick={onOpen}
      className="grid grid-cols-[34px_1fr_auto] items-center gap-4 sm:grid-cols-[34px_1fr_150px_116px_100px]"
    >
      <DoorChip door={row.door} variant="tile-34" />
      <div className="min-w-0">
        <div className="text-row-title">{DOOR_TITLE[row.door]}</div>
        <Mono size="xs" tone="faint" truncate className="mt-0.5">
          {shortAddress(row.agentPayer ?? row.payer)}
        </Mono>
      </div>
      <Money
        variant="token"
        size="md"
        units={row.amountIn}
        dp={6}
        suffix={row.tokenSymbol}
        tone="faint"
        className="hidden text-right sm:block"
      />
      <Mono size="sm" tone="muted" className="hidden text-right sm:block">
        {clockTime(row.blockTime)}
      </Mono>
      <Money units={row.xsgdOut} prefix="S$" size="lg" className="text-right" />
    </Row>
  );
}
