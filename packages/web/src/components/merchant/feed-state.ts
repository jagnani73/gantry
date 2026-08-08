import { dayKey, groupByDay, type SettlementEvent } from "@gantry/shared";
import type { FeedConnection } from "./use-merchant-feed";

/**
 * The three states the feed can be in, and the one thing they must never do:
 * claim to be live when they are not.
 *
 * `disconnected` is deliberately its own state rather than a flavour of empty.
 * Payments keep settling on-chain while this screen cannot see them, and telling
 * a merchant "no payments yet" in that situation is the single most damaging
 * thing the dashboard could say.
 */
export type FeedState = "live" | "empty" | "disconnected";

export interface FeedStatus {
  state: FeedState;
  label: string;
  tone: "accent" | "warning" | "danger";
}

export function feedStatusOf(connection: FeedConnection, todayCount: number): FeedStatus {
  if (connection === "disconnected") {
    return { state: "disconnected", label: "Disconnected", tone: "danger" };
  }
  if (connection === "connecting") {
    // A fourth label over three visual states: "Waiting" would imply the stream
    // is open and idle, which is a claim we cannot make yet.
    return { state: "empty", label: "Connecting…", tone: "warning" };
  }
  return todayCount > 0
    ? { state: "live", label: "Live", tone: "accent" }
    : { state: "empty", label: "Waiting", tone: "warning" };
}

/**
 * The rows that belong to today, in the merchant's own zone.
 *
 * `groupByDay` rather than a hand-rolled filter because the zone is pinned
 * inside it: a UTC backend and an SGT browser disagree about which day a payment
 * belongs to between midnight and 08:00 SGT, and the day header would then
 * contradict the total sitting above it.
 */
export function rowsForToday(
  rows: readonly SettlementEvent[],
  nowSeconds: number | null,
): readonly SettlementEvent[] {
  if (nowSeconds === null) return [];
  const today = dayKey(nowSeconds);
  return groupByDay(rows, (row) => row.blockTime).find((group) => group.day === today)?.rows ?? [];
}
