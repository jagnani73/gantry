"use client";

import { useState } from "react";
import { groupByDay } from "@gantry/shared";
import { Card, cn, Label, Money } from "@/components/primitives";
import { ActivityRowItem } from "./activity-row";
import { activityTotal, filterActivity, type ActivityFilter } from "./activity";
import { dayHeading } from "./format";
import { usePayer } from "./payer-context";

const FILTERS: readonly { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "me", label: "Me" },
  { id: "agents", label: "My agents" },
];

/**
 * Everything the payer and their agents have spent, in day groups.
 *
 * The day totals sum SETTLED payments only. A refused attempt sits in the list —
 * it is the most interesting row on the screen — but it moved nothing, so
 * counting it would make the total disagree with the wallet balance above it.
 */
export function ActivityScreen() {
  const { identity, rows, settlements, settlementsError, chainNow } = usePayer();
  const [filter, setFilter] = useState<ActivityFilter>("all");

  const shown = filterActivity(rows, identity.address, filter);
  const groups = groupByDay(shown, (row) => row.at);
  const now = chainNow();

  return (
    <>
      <h1 className="text-screen-title">Activity</h1>

      <div className="mt-4 flex gap-1.5 rounded-tile bg-surface p-1">
        {FILTERS.map((option) => {
          const on = option.id === filter;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(option.id)}
              className={cn(
                "focus-ring flex-1 rounded-control py-2 text-center text-meta transition-colors",
                on ? "bg-fill-subtle font-medium text-ink" : "text-muted hover:text-ink",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {settlementsError ? (
        <Card tone="danger" radius="control-m" pad="none" className="mt-4 px-4 py-3.5">
          <p className="text-meta-sm break-words">{settlementsError}</p>
        </Card>
      ) : null}

      {identity.ready && !identity.address ? (
        <p className="mt-6 text-body-sm text-muted">
          Connect a wallet in Settings to see your payments.
        </p>
      ) : settlements === null ? (
        <p className="mt-6 text-body-sm text-muted">Loading your payments…</p>
      ) : groups.length === 0 ? (
        <p className="mt-6 text-body-sm text-muted">
          {rows.length === 0
            ? "No payments yet. Scan a shop's code and it appears here the moment it settles."
            : "Nothing matches that filter."}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.day} className="mt-5.5">
            <div className="flex items-baseline justify-between gap-3">
              <Label>{dayHeading(group.day, now)}</Label>
              <Money
                units={activityTotal(group.rows)}
                prefix="S$"
                variant="token"
                size="md"
                tone="muted"
              />
            </div>
            <Card radius="card" pad="none" className="mt-2 px-4 py-1.5">
              {group.rows.map((row) => (
                <ActivityRowItem key={row.key} row={row} />
              ))}
            </Card>
          </section>
        ))
      )}
      <div className="h-3" />
    </>
  );
}
