import type { SettlementCursor } from "./api";

/**
 * Settlement feed cursors — `${blockNumber}:${logIndex}`.
 *
 * This is the SSE event id's grammar (routes/events.ts parses Last-Event-ID
 * with the same `\d+:\d+` shape), reused rather than reinvented: one string
 * says "where I am in the feed" whether it came from the live stream or from a
 * page of history, and a second encoding would be two things to keep in step.
 *
 * A cursor is a POSITION, not an offset. Rows are ordered by (blockNumber,
 * logIndex), so new settlements arriving at the head while a client pages
 * backwards cannot shift the page under it — which an offset would.
 */
export interface CursorPosition {
  blockNumber: number;
  logIndex: number;
}

const CURSOR = /^(\d+):(\d+)$/;

function isIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Throws on a nonsense position: `"NaN:0"` would travel back as a cursor the
 * server can never match, and the client would page forever. */
export function encodeCursor(position: CursorPosition): SettlementCursor {
  const { blockNumber, logIndex } = position;
  if (!isIndex(blockNumber) || !isIndex(logIndex)) {
    throw new Error(`invalid cursor position: ${blockNumber}:${logIndex}`);
  }
  return `${blockNumber}:${logIndex}`;
}

/**
 * null means MALFORMED, and only that — an absent `before` is the caller's own
 * business to detect. Keep them apart: a missing cursor means "give me the
 * newest page", while an unparseable one means the client asked for a position
 * that cannot exist and deserves a 400. Answering it with page 1 instead gives
 * an infinite scroll that re-fetches the same rows until the tab is closed.
 *
 * Tolerant about surrounding whitespace (it arrives as a query param) and about
 * leading zeros; `encodeCursor` always emits the canonical form.
 */
export function decodeCursor(raw: string): CursorPosition | null {
  const match = CURSOR.exec(raw.trim());
  if (!match) return null;
  const blockNumber = Number(match[1]);
  const logIndex = Number(match[2]);
  // Past 2^53 `Number` silently rounds, so a garbage cursor would decode to a
  // plausible-looking block and page from the wrong place.
  if (!isIndex(blockNumber) || !isIndex(logIndex)) return null;
  return { blockNumber, logIndex };
}
