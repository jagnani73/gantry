"use client";

import { shortAddress, type SettlementEvent } from "@gantry/shared";
import { DoorChip, Money, Mono, Row } from "@/components/primitives";
import { DOOR_TITLE } from "./door-copy";
import { clockTime, feedDay } from "./format";

/**
 * One line of the live feed.
 *
 * A bridged x402 payment shows "via facilitator" instead of an address: its
 * on-chain payer is the RELAYER, and printing that would tell a merchant the
 * same customer paid fourteen times. The buyer's own address is not available
 * to print — it exists nowhere on-chain, which is the reason for the hop in the
 * first place. Every other row shows its real on-chain payer, and nothing more:
 * no agent identity, no policy, no balance, none of which this surface sees.
 */
export function SettlementFeedRow({
  row,
  fresh,
  nowSeconds,
  onOpen,
}: {
  row: SettlementEvent;
  fresh: boolean;
  /** Anchors "Today"/"Yesterday". Null until the clock mounts, which `feedDay`
   * answers with the absolute day rather than with nothing. */
  nowSeconds: number | null;
  onOpen(): void;
}) {
  return (
    <Row
      interactive
      highlight={fresh}
      onClick={onOpen}
      className="grid grid-cols-[34px_1fr_auto] items-center gap-4 sm:grid-cols-[34px_1fr_150px_152px_100px]"
    >
      <DoorChip door={row.door} variant="tile-34" />
      <div className="min-w-0">
        <div className="text-row-title">{DOOR_TITLE[row.door]}</div>
        {row.bridged ? (
          <div className="mt-0.5 text-meta-sm text-faint">via facilitator</div>
        ) : (
          <Mono size="xs" tone="faint" truncate className="mt-0.5">
            {shortAddress(row.payer)}
          </Mono>
        )}
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
      {/* Stacked, matching Transactions: the day sits above the clock rather
          than in front of it, so the column keeps one width whether the label
          reads "Today" or "Yesterday" — inline, a longer label pushed the time
          left and the times stopped lining up. It costs no height, because the
          payer cell opposite is already two lines. Both lines are Mono, so day
          and clock share one tabular grid. */}
      <div className="hidden flex-col gap-0.5 text-right sm:flex">
        <Mono size="3xs" tone="faintest" className="whitespace-nowrap">
          {feedDay(row.blockTime, nowSeconds)}
        </Mono>
        <Mono size="sm" tone="muted" className="whitespace-nowrap">
          {clockTime(row.blockTime)}
        </Mono>
      </div>
      <Money units={row.xsgdOut} prefix="S$" size="lg" className="text-right" />
    </Row>
  );
}
