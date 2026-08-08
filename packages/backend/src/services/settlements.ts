import type { Address, Hex } from "viem";
import {
  decodeCursor,
  doorToWire,
  encodeCursor,
  isValidHandle,
  parsePayerFilter,
  type CursorPosition,
  type Door,
  type SettlementCursor,
  type SettlementEvent,
  type SettlementListResponse,
  type TokenId,
} from "@gantry/shared";
import { ApiError } from "../errors";
import type { SettlementFilter, SettlementRow } from "../db-core";

/**
 * GET /api/settlements — paged settlement history, newest-first. It serves the
 * same rows the SSE stream delivers live and speaks the same
 * `${blockNumber}:${logIndex}` grammar, so a client merging a history page into
 * a running feed dedupes on the key the server already treats as primary.
 *
 * Everything that touches the environment arrives as an ARGUMENT rather than an
 * import: the store, and the one lookup `toSettlementEvent` cannot do on its own
 * (naming a token needs the configured address table). That keeps this module
 * free of `../db` (which opens SQLite on import) and of `../indexer` (which
 * pulls in config and the chain clients, and config exits the process when the
 * environment is missing — CI runs the backend suite with no environment at
 * all). Same reason facilitator-core.ts and pbm-core.ts are split from their
 * wired siblings: what lives here is the part worth testing, and the mapping is
 * as much of it as the paging is.
 */

/** Names the token a settlement was paid in. Injected because
 * `tokenIdByAddress` needs the configured address table; `../indexer` binds it
 * once and every caller shares that binding. */
export type TokenSymbolLookup = (token: Address) => TokenId | null;

/**
 * The ONE row→wire mapping: the live SSE push, the reconnect replay and the
 * paged read below all go through it, so a row a client received live and the
 * same row re-fetched from history cannot disagree about a field.
 *
 * `logIndex` is on the event for that reason and not as decoration —
 * `(txHash, logIndex)` is the store's primary key, so it is what a client
 * merging a history page into a running feed dedupes on. Drop it and the feed
 * renders every row it holds from both sources twice.
 */
export function toSettlementEvent(
  row: SettlementRow,
  tokenSymbolOf: TokenSymbolLookup,
): SettlementEvent {
  return {
    intentId: row.intent_id as Hex,
    merchantId: row.merchant_id as Hex,
    handle: row.handle,
    payer: row.payer as Address,
    ...(row.agent_payer ? { agentPayer: row.agent_payer as Address } : {}),
    tokenIn: row.token_in as Address,
    tokenSymbol: tokenSymbolOf(row.token_in as Address),
    amountIn: row.amount_in,
    xsgdOut: row.xsgd_out,
    feeXsgd: row.fee_xsgd,
    door: doorToWire(row.door as Door),
    txHash: row.tx_hash as Hex,
    blockNumber: row.block_number,
    logIndex: row.log_index,
    blockTime: row.block_time,
  };
}

/**
 * A row's own position in the feed — the SSE event id AND the paging cursor,
 * one grammar for both. Minted through `encodeCursor` so a row that cannot name
 * a position fails here rather than travelling back as `"NaN:0"`, which no
 * `?before=` and no `Last-Event-ID` could ever match.
 */
export function cursorOf(row: SettlementRow): SettlementCursor {
  return encodeCursor({ blockNumber: row.block_number, logIndex: row.log_index });
}

/** No caller has ever wanted a different first page, and a page size is a
 * product decision rather than config. */
export const DEFAULT_SETTLEMENT_LIMIT = 50;
/**
 * Bounds one response and one SQLite scan on the connection the indexer sweep
 * is also writing through. Clamped rather than refused: a client asking for
 * more is asking for "everything", and the sidebar's `total` already answers
 * that question without paging.
 */
export const MAX_SETTLEMENT_LIMIT = 200;

/** Express hands each query value as a string, an array (repeated param) or a
 * nested object (`?a[b]=c`) — hence `unknown` rather than a lie. */
export type QueryParams = Record<string, unknown>;

export interface SettlementPageQuery {
  filter: SettlementFilter;
  /** null = the newest page. A cursor is a POSITION, so rows arriving at the
   * head while a client pages backwards cannot shift the page under it. */
  before: CursorPosition | null;
  limit: number;
}

/** The slice of the SQLite store this read needs — nothing else, so a test can
 * supply a temp database (or a spy) without standing up the singleton. */
export interface SettlementReader {
  listSettlements(
    filter: SettlementFilter,
    before: CursorPosition | null,
    limit: number,
  ): { rows: SettlementRow[]; hasMore: boolean };
  countSettlements(filter: SettlementFilter): number;
}

export interface SettlementHistoryDeps {
  store: SettlementReader;
  /** `settlementEventOf` from the indexer — `toSettlementEvent` above, bound to
   * the configured address table. It is the same binding the SSE broadcast
   * uses, which is what keeps a paged row and a streamed row identical. */
  toEvent: (row: SettlementRow) => SettlementEvent;
}

function single(params: QueryParams, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    // A repeated `?payer=a&payer=b` arrives as an array. Joining it would work
    // for the payer list and silently pick a winner for handle/before/limit;
    // refusing says which it was.
    throw new ApiError(400, "ValidationError", `${name} must be given at most once`);
  }
  return value;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SETTLEMENT_LIMIT;
  const trimmed = raw.trim();
  // Falling back to the default would hand back a page of a size the caller did
  // not ask for, and `?limit=0` would render an empty-but-healthy feed.
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    throw new ApiError(
      400,
      "ValidationError",
      `limit must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return Math.min(Number(trimmed), MAX_SETTLEMENT_LIMIT);
}

/** Pure: query string in, the three things the store needs out. Every rejection
 * here is a 400 — none of them can be guessed at without lying to a screen. */
export function parseSettlementQuery(params: QueryParams): SettlementPageQuery {
  const handle = single(params, "handle");
  // `?handle=` would fall through db-core's truthiness check and quietly widen a
  // merchant screen to every shop on the rail — strangers' takings under this
  // merchant's name. Validated the same way `getMerchant` validates it, so the
  // two surfaces agree on what a handle is.
  if (handle !== undefined && !isValidHandle(handle)) {
    throw new ApiError(400, "InvalidHandle", `not a valid merchant handle: ${handle}`);
  }

  // Absent = every payer. Present-but-empty is refused by parsePayerFilter, for
  // the reason spelled out there: both defaults are invisible and wrong.
  const payer = parsePayerFilter(single(params, "payer"));
  if (!payer.ok) {
    throw new ApiError(400, "InvalidPayerFilter", payer.message, [payer.reason]);
  }

  const rawCursor = single(params, "before");
  let before: CursorPosition | null = null;
  if (rawCursor !== undefined) {
    before = decodeCursor(rawCursor);
    // Absence means "newest page"; unparseable means the client named a
    // position that cannot exist. Answering that with page 1 gives an infinite
    // scroll that re-fetches the same rows until the tab closes.
    if (before === null) {
      throw new ApiError(
        400,
        "InvalidCursor",
        `before must be a \`blockNumber:logIndex\` cursor, got ${JSON.stringify(rawCursor)}`,
      );
    }
  }

  return {
    filter: {
      ...(handle !== undefined ? { handle } : {}),
      ...(payer.payers ? { payers: [...payer.payers] } : {}),
    },
    before,
    limit: parseLimit(single(params, "limit")),
  };
}

export function listSettlementHistory(
  deps: SettlementHistoryDeps,
  params: QueryParams,
): SettlementListResponse {
  const { filter, before, limit } = parseSettlementQuery(params);
  const { rows, hasMore } = deps.store.listSettlements(filter, before, limit);
  const last = rows[rows.length - 1];
  return {
    rows: rows.map((row) => deps.toEvent(row)),
    // Minted from the last row rather than from the request, so any row a
    // client already holds can resume the scroll. `hasMore` cannot be true with
    // an empty page (the store reads limit+1), but derive from the row anyway —
    // a cursor invented from nothing is what paints a dead "Load more".
    nextCursor: hasMore && last ? cursorOf(last) : null,
    // Deliberately the unpaginated count: it is the sidebar's nav badge, and a
    // page size must never be mistaken for how much a merchant took.
    total: deps.store.countSettlements(filter),
  };
}
