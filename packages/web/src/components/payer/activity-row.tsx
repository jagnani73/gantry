"use client";

import { DoorChip, Money, Row } from "@/components/primitives";
import type { ActivityRow } from "./activity";
import { relativeWhen } from "./format";
import { usePayer } from "./payer-context";

/**
 * One line of history, used by Recent, Activity and an agent's own spend list.
 *
 * A refused payment sits in the same list as a settled one and must be
 * unmistakable from it: the ✕ chip, the words "Declined on-chain", and the
 * amount struck through because it never moved. It is also absent from every
 * total — see `activityTotal`, which filters on the row's kind rather than on a
 * flag a caller could forget.
 */
export function ActivityRowItem({ row }: { row: ActivityRow }) {
  const { merchant, chainNow, pushOverlay } = usePayer();
  const record = merchant(row.handle);
  const title = record?.displayName ?? row.handle;
  const when = relativeWhen(row.at, chainNow());

  const declined = row.kind === "denial";
  const units = declined ? row.denial.xsgdAmount : row.settlement.xsgdOut;

  return (
    <Row
      pad="list"
      divider="paper"
      interactive
      onClick={() => pushOverlay({ kind: "receipt", row })}
      className="flex items-center gap-3 last:border-b-0"
    >
      <DoorChip door={declined ? "declined" : row.settlement.door} variant="tile-36" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-row-title">{title}</span>
        <span className="mt-0.5 block truncate text-fine text-faint">
          {declined ? `Declined on-chain · ${when}` : when}
        </span>
      </span>
      <Money
        units={units}
        prefix="S$"
        size="sm"
        strike={declined}
        tone={declined ? "faintest" : "ink"}
      />
    </Row>
  );
}
