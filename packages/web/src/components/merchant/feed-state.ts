import { dayKey, groupByDay, type SettlementEvent } from "@gantry/shared";
import type { FeedConnection } from "./use-merchant-feed";

export interface FeedStatus {
  readonly label: string;
  readonly tone: "accent" | "warning" | "danger";
}

/**
 * One badge per connection state, and the one thing it must never do: claim to
 * be live when it is not.
 *
 * It describes the STREAM, not the takings. A connected feed with no payments
 * yet today is still live, so the amber "Waiting" that used to sit on that case
 * is gone — it read as a fault in the connection rather than as a quiet morning,
 * and on a demo day it is the first thing on a cold screen. On Overview an empty
 * day is already said in the two places that are actually about money, the
 * "Nothing settled yet today" figure and the "No payments yet today" feed body;
 * on the other five merchant screens the sidebar carries this badge alone, and
 * there an empty day is simply not the badge's subject.
 *
 * `disconnected` is deliberately its own entry rather than a quieter kind of
 * empty. Payments keep settling on-chain while this screen cannot see them, and
 * telling a merchant "no payments yet" in that situation is the single most
 * damaging thing the dashboard could say. `connecting` stays distinct for the
 * same reason: until the stream is open, "Live" is a claim we cannot make.
 *
 * A table rather than a chain of `if`s so that a fourth `FeedConnection` member
 * fails to compile here. Under `if/else` it would fall through to "Live", which
 * is the single direction this file exists to prevent.
 */
const FEED_STATUS = {
  live: { label: "Live", tone: "accent" },
  connecting: { label: "Connecting…", tone: "warning" },
  disconnected: { label: "Disconnected", tone: "danger" },
} as const satisfies Record<FeedConnection, FeedStatus>;

export function feedStatusOf(connection: FeedConnection): FeedStatus {
  return FEED_STATUS[connection];
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

/**
 * Whether today's figures are a floor rather than a total.
 *
 * The feed pages backwards from the newest row, so today's rows are a prefix of
 * what is loaded: the moment one loaded row predates today, today is complete and
 * the KPIs are exact no matter how many older pages remain. Only when EVERY
 * loaded row falls today can an unloaded page still hold more of it — and then
 * the day's takings, its payment count and the card comparison are all lower
 * bounds, which a merchant cannot possibly infer from the screen.
 */
export function todayIsPartial(
  todayCount: number,
  loadedCount: number,
  hasMore: boolean,
): boolean {
  return hasMore && loadedCount > 0 && todayCount === loadedCount;
}
