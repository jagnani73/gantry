import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { Door, doorToWire, type SettlementEvent } from "@gantry/shared";
import { createDatabase, type SettlementRow } from "../src/db-core";
import { ApiError } from "../src/errors";
import {
  listSettlementHistory,
  parseSettlementQuery,
  type SettlementHistoryDeps,
} from "../src/services/settlements";

/**
 * Service-level tests against a real temp SQLite file (db.test.ts precedent):
 * the paging rules are only true in combination with the SQL, so a fake store
 * would pin the wrong half. What stays out is the wiring — services/settlements
 * takes its store and mapper as arguments precisely so this file needs no
 * config, no chain client and no environment.
 */

const dir = mkdtempSync(join(tmpdir(), "gantry-settlements-test-"));
const store = createDatabase(join(dir, "test.db"));

after(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Stands in for indexer.settlementEventOf, which cannot be imported here (it
 * reads config.addresses to name the token, and config exits the process
 * without an environment). Same shape minus that one lookup: the mapping is the
 * indexer's, what these tests own is WHICH rows come back, in what order.
 */
function toEvent(row: SettlementRow): SettlementEvent {
  return {
    intentId: row.intent_id as Hex,
    merchantId: row.merchant_id as Hex,
    handle: row.handle,
    payer: row.payer as Address,
    ...(row.agent_payer ? { agentPayer: row.agent_payer as Address } : {}),
    tokenIn: row.token_in as Address,
    tokenSymbol: null,
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

const deps: SettlementHistoryDeps = { store, toEvent };

const HUMAN = "0x1111111111111111111111111111111111111111";
/** The demo PBM wallet, checksummed as the chain and the UI render it — stored
 * lowercase, so it also pins that a filter does not have to match casing. */
const AGENT_WALLET = "0xDD4bbed78B64715288bf10fabB2b62c659299D3E";
const RELAYER = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B";
const STRANGER = "0x9999999999999999999999999999999999999999";

const AH_HOCK = "ah-hock-chicken-rice";
const GADGETHUB = "gadgethub-sg";

function settlement(
  block: number,
  logIndex: number,
  overrides: Partial<SettlementRow> = {},
): SettlementRow {
  return {
    tx_hash: `0xtx${block}-${logIndex}`,
    log_index: logIndex,
    intent_id: `0xintent${block}-${logIndex}`,
    merchant_id: "0xmerchant",
    handle: AH_HOCK,
    payer: HUMAN,
    token_in: "0xtoken",
    amount_in: "1117652",
    xsgd_out: "1500000",
    fee_xsgd: "7500",
    door: Door.Human,
    block_number: block,
    block_time: 1_785_900_000 + block,
    agent_payer: null,
    ...overrides,
  };
}

// Five settlements, newest last: 10:0, 10:2, 11:0, 12:0, 13:1.
store.insertSettlementRow(settlement(10, 0));
store.insertSettlementRow(settlement(10, 2));
// A bridged vanilla-x402 payment: on-chain payer is the relayer, the agent that
// actually paid is recorded beside it.
store.insertSettlementRow(
  settlement(11, 0, { payer: RELAYER, agent_payer: AGENT_WALLET, door: Door.Agent }),
);
// A gantry-pbm payment: the wallet IS the on-chain payer, no bridge hop.
store.insertSettlementRow(
  settlement(12, 0, { payer: AGENT_WALLET, handle: GADGETHUB, door: Door.Agent }),
);
store.insertSettlementRow(settlement(13, 1, { payer: STRANGER }));

function positions(response: { rows: SettlementEvent[] }): [number, number][] {
  return response.rows.map((row) => [row.blockNumber, row.logIndex]);
}

/** Asserts the call was refused, and hands back the refusal to inspect. */
function refusal(params: Record<string, unknown>): ApiError {
  try {
    listSettlementHistory(deps, params);
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${String(err)}`);
    return err;
  }
  return assert.fail("expected a 400, got a page of rows");
}

test("rows come back newest-first, ordered within a block too", () => {
  const page = listSettlementHistory(deps, {});
  assert.deepEqual(positions(page), [
    [13, 1],
    [12, 0],
    [11, 0],
    [10, 2],
    [10, 0],
  ]);
  assert.equal(page.nextCursor, null, "one page holds everything — nothing to page to");
  assert.equal(page.total, 5);
});

test("nextCursor walks the feed without repeating or skipping a row", () => {
  const seen: [number, number][] = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const params = before === undefined ? { limit: "2" } : { limit: "2", before };
    const result = listSettlementHistory(deps, params);
    seen.push(...positions(result));
    if (result.nextCursor === null) break;
    before = result.nextCursor;
  }
  assert.deepEqual(seen, [
    [13, 1],
    [12, 0],
    [11, 0],
    [10, 2],
    [10, 0],
  ]);
});

test("an exactly-full last page still reports nextCursor null", () => {
  // The off-by-one that paints a "Load more" link returning nothing: exactly two
  // rows remain after 11:0, so the final page is FULL and must still end the
  // scroll. A limit+1 read is what makes that answerable without a second query.
  const last = listSettlementHistory(deps, { limit: "2", before: "11:0" });
  assert.deepEqual(positions(last), [
    [10, 2],
    [10, 0],
  ]);
  assert.equal(last.nextCursor, null);
});

test("a cursor is exclusive — the row it names is not repeated", () => {
  const page = listSettlementHistory(deps, { before: "12:0" });
  assert.ok(!page.rows.some((row) => row.blockNumber === 12));
});

test("a malformed cursor is refused, never answered with page 1", () => {
  // Silently restarting at the head is an infinite scroll that re-fetches the
  // same rows until the tab is closed.
  for (const before of ["", "abc", "12", "12:", ":0", "12:0:1", "-1:0", "1e3:0"]) {
    const err = refusal({ before });
    assert.equal(err.status, 400, `before=${JSON.stringify(before)} must be a 400`);
    assert.equal(err.errorName, "InvalidCursor");
  }
});

test("an absent cursor is the newest page, not a malformed one", () => {
  assert.equal(parseSettlementQuery({}).before, null);
  assert.deepEqual(positions(listSettlementHistory(deps, { limit: "1" })), [[13, 1]]);
});

test("a present-but-empty payer filter is refused", () => {
  // "match everything" leaks strangers' payments into someone's activity feed;
  // "match nothing" renders a healthy-looking empty one. Both are invisible.
  for (const payer of ["", " ", ",,", " , "]) {
    const err = refusal({ payer });
    assert.equal(err.status, 400, `payer=${JSON.stringify(payer)} must be a 400`);
    assert.equal(err.errorName, "InvalidPayerFilter");
    assert.deepEqual(err.args, ["empty"]);
  }
  // A filter is a read, so casing is normalised rather than policed — but a
  // string that is not an address at all still cannot mean anything.
  const malformed = refusal({ payer: `${HUMAN},not-an-address` });
  assert.equal(malformed.errorName, "InvalidPayerFilter");
  assert.deepEqual(malformed.args, ["malformed"]);
});

test("a payer filter matches the on-chain payer OR the bridged agent payer", () => {
  // 12:0 is the wallet paying directly; 11:0 is the same wallet behind the
  // facilitator bridge, where the on-chain payer is the relayer. A feed that
  // showed only the first is the bug this OR exists to prevent.
  const mine = listSettlementHistory(deps, { payer: AGENT_WALLET });
  assert.deepEqual(positions(mine), [
    [12, 0],
    [11, 0],
  ]);
  assert.equal(mine.total, 2);

  // "me and my agents" in one query — the payer app's activity feed.
  const meAndMine = listSettlementHistory(deps, { payer: `${HUMAN},${AGENT_WALLET}` });
  assert.deepEqual(positions(meAndMine), [
    [12, 0],
    [11, 0],
    [10, 2],
    [10, 0],
  ]);
  assert.equal(meAndMine.total, 4);
});

test("a payer filter that names nobody we know returns an honest empty page", () => {
  const none = listSettlementHistory(deps, { payer: "0x00000000000000000000000000000000deadbeef" });
  assert.deepEqual(none.rows, []);
  assert.equal(none.total, 0);
  assert.equal(none.nextCursor, null);
});

test("handle scopes the feed, and a nonsense handle is refused", () => {
  const scoped = listSettlementHistory(deps, { handle: GADGETHUB });
  assert.deepEqual(positions(scoped), [[12, 0]]);
  assert.equal(scoped.total, 1);

  // `?handle=` would fall through to "every shop" — a merchant screen showing
  // strangers' takings under this merchant's name.
  for (const handle of ["", "Ah-Hock", "not a handle", "-leading"]) {
    const err = refusal({ handle });
    assert.equal(err.status, 400, `handle=${JSON.stringify(handle)} must be a 400`);
    assert.equal(err.errorName, "InvalidHandle");
  }
});

test("handle and payer combine as AND", () => {
  assert.deepEqual(
    positions(listSettlementHistory(deps, { handle: AH_HOCK, payer: AGENT_WALLET })),
    [[11, 0]],
  );
});

test("total ignores pagination — it is a nav count, not a page size", () => {
  const page = listSettlementHistory(deps, { limit: "1" });
  assert.equal(page.rows.length, 1);
  assert.equal(page.total, 5);
  assert.equal(page.nextCursor, "13:1");

  const scoped = listSettlementHistory(deps, { handle: AH_HOCK, limit: "1" });
  assert.equal(scoped.total, 4, "the count must honour the same filter as the page");
});

test("limit defaults to 50, clamps at 200, and refuses nonsense", () => {
  assert.equal(parseSettlementQuery({}).limit, 50);
  assert.equal(parseSettlementQuery({ limit: "10" }).limit, 10);
  assert.equal(parseSettlementQuery({ limit: "200" }).limit, 200);
  assert.equal(parseSettlementQuery({ limit: "201" }).limit, 200);
  assert.equal(parseSettlementQuery({ limit: "99999999999999999999" }).limit, 200);

  for (const limit of ["", "0", "-1", "1.5", "abc", "50; DROP TABLE settlements"]) {
    const err = refusal({ limit });
    assert.equal(err.status, 400, `limit=${JSON.stringify(limit)} must be a 400`);
    assert.equal(err.errorName, "ValidationError");
  }
});

test("the clamped limit is what reaches the query", () => {
  const asked: number[] = [];
  const spy: SettlementHistoryDeps = {
    store: {
      listSettlements: (filter, before, limit) => {
        asked.push(limit);
        return store.listSettlements(filter, before, limit);
      },
      countSettlements: (filter) => store.countSettlements(filter),
    },
    toEvent,
  };
  listSettlementHistory(spy, { limit: "5000" });
  assert.deepEqual(asked, [200]);
});

test("a repeated query param is refused rather than silently resolved", () => {
  // Express hands `?handle=a&handle=b` over as an array; picking one is a guess
  // about which merchant's takings the screen is showing.
  const err = refusal({ handle: [AH_HOCK, GADGETHUB] });
  assert.equal(err.status, 400);
  assert.equal(err.errorName, "ValidationError");
});

test("rows carry the fields a client merges the live stream on", () => {
  const [newest] = listSettlementHistory(deps, { limit: "1" }).rows;
  assert.equal(newest?.txHash, "0xtx13-1");
  assert.equal(newest?.logIndex, 1, "the row must be able to mint its own cursor");
  assert.equal(newest?.blockNumber, 13);

  const bridged = listSettlementHistory(deps, { before: "12:0", limit: "1" }).rows[0];
  assert.equal(bridged?.payer, RELAYER.toLowerCase());
  assert.equal(bridged?.agentPayer, AGENT_WALLET.toLowerCase());
  assert.equal(bridged?.door, "agent");
});
