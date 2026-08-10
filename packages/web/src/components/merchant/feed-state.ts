import { rowsInOverviewWindow, type SettlementEvent } from "@gantry/shared";
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
 * in the window is still live, so the amber "Waiting" that used to sit on that
 * case is gone — it read as a fault in the connection rather than as a quiet
 * week, and on a demo day it is the first thing on a cold screen. On Overview an
 * empty window is already said in the two places that are actually about money,
 * the "Nothing settled…" figure and the "No payments…" feed body — both of which
 * name the window length from `OVERVIEW_WINDOW_DAYS`, so this comment does not
 * quote them; on the other five merchant screens the sidebar carries this badge
 * alone, and there an empty window is simply not the badge's subject.
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
 * The window's rows, or none before the clock has mounted.
 *
 * A thin wrapper: the arithmetic lives in `@gantry/shared/overviewWindow`,
 * where it can be tested, and the `null` handled here is a client-render
 * concern rather than part of it — `useNowSeconds` returns null until mount so
 * that the server and the first client paint agree.
 */
export function rowsForOverviewWindow(
  rows: readonly SettlementEvent[],
  nowSeconds: number | null,
): readonly SettlementEvent[] {
  if (nowSeconds === null) return [];
  return rowsInOverviewWindow(rows, (row) => row.blockTime, nowSeconds);
}
