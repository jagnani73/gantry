import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type SettlementRow, type IntentRow } from "../src/db-core";

const dir = mkdtempSync(join(tmpdir(), "gantry-db-test-"));
const store = createDatabase(join(dir, "test.db"));

after(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function settlement(
  block: number,
  logIndex: number,
  overrides: Partial<SettlementRow> = {},
): SettlementRow {
  return {
    ...base(block, logIndex),
    ...overrides,
  };
}

function base(block: number, logIndex: number): SettlementRow {
  return {
    tx_hash: `0xtx${block}-${logIndex}`,
    log_index: logIndex,
    intent_id: `0xintent${block}-${logIndex}`,
    merchant_id: "0xmerchant",
    handle: "ah-hock-chicken-rice",
    payer: "0xPayer",
    token_in: "0xToken",
    amount_in: "4843157",
    xsgd_out: "6500001",
    fee_xsgd: "32500",
    door: 0,
    block_number: block,
    block_time: 1_785_900_000 + block,
  };
}

test("insertSettlementRow dedups on (tx_hash, log_index)", () => {
  assert.equal(store.insertSettlementRow(settlement(10, 0)), true);
  assert.equal(store.insertSettlementRow(settlement(10, 0)), false); // watch+sweep overlap
});

test("settlementsAfter is a strict compound cursor", () => {
  store.insertSettlementRow(settlement(10, 2));
  store.insertSettlementRow(settlement(11, 0));

  const after10_0 = store.settlementsAfter(10, 0);
  assert.deepEqual(
    after10_0.map((r) => [r.block_number, r.log_index]),
    [
      [10, 2],
      [11, 0],
    ],
  ); // excludes the cursor row itself, ascending order

  assert.deepEqual(store.settlementsAfter(11, 0), []);
});

test("recentSettlements returns the newest N in ascending order", () => {
  const recent = store.recentSettlements(2);
  assert.deepEqual(
    recent.map((r) => [r.block_number, r.log_index]),
    [
      [10, 2],
      [11, 0],
    ],
  );
});

test("intent rows normalize ids to lowercase on write and read", () => {
  const row: IntentRow = {
    intent_id: "0xABCDEF",
    merchant_id: "0xMERCHANT",
    handle: "ah-hock-chicken-rice",
    token_in: "0xTOKEN",
    amount_in: "4843157",
    xsgd_amount: "6500000",
    rate: "1342100",
    expiry: 1_785_900_600,
    door: 0,
    status: "pending",
    valid_before: 1_785_901_320,
    created_tx: "0xcreate",
    settle_tx: null,
    created_at: 1_785_900_000,
  };
  store.insertIntentRow(row);
  const got = store.getIntentRow("0xAbCdEf"); // checksummed lookup must hit
  assert.equal(got?.intent_id, "0xabcdef");
  assert.equal(got?.token_in, "0xtoken");
});

test("setIntentStatus preserves settle_tx via COALESCE", () => {
  store.setIntentStatus("0xabcdef", "settled", "0xsettletx");
  assert.equal(store.getIntentRow("0xabcdef")?.settle_tx, "0xsettletx");
  store.setIntentStatus("0xabcdef", "settled");
  assert.equal(store.getIntentRow("0xabcdef")?.settle_tx, "0xsettletx");
});

test("listSettlements pages newest-first and reports hasMore honestly", () => {
  // Existing rows at this point: (10,0), (10,2), (11,0) — all ah-hock/0xPayer.
  const first = store.listSettlements({}, null, 2);
  assert.deepEqual(
    first.rows.map((r) => [r.block_number, r.log_index]),
    [
      [11, 0],
      [10, 2],
    ],
  );
  assert.equal(first.hasMore, true);

  const second = store.listSettlements({}, { blockNumber: 10, logIndex: 2 }, 2);
  assert.deepEqual(
    second.rows.map((r) => [r.block_number, r.log_index]),
    [[10, 0]],
  );
  // The last page must not claim a next one — an off-by-one here paints a
  // "Load more" link that returns nothing.
  assert.equal(second.hasMore, false);
});

test("listSettlements cursor is exclusive within a block", () => {
  const page = store.listSettlements({}, { blockNumber: 10, logIndex: 2 }, 10);
  assert.ok(!page.rows.some((r) => r.block_number === 10 && r.log_index === 2));
});

test("the payer filter matches the on-chain payer, and only that", () => {
  // A bridged x402 payment settles with the RELAYER as on-chain payer, and the
  // buyer's own address exists nowhere on-chain — so it is nobody's row here.
  // It used to be matched via a stored `agent_payer`, which only the backend
  // that performed the hop ever held; see SettlementEvent.bridged.
  store.insertSettlementRow(
    settlement(12, 0, { payer: "0xRelayer", handle: "gadgethub-sg" }),
  );
  store.insertSettlementRow(settlement(13, 0, { payer: "0xAgent", handle: "gadgethub-sg" }));

  // Only block 13. The bridged row at 12 is the relayer's on every host, which
  // is the on-chain truth — it is not silently the agent's here and nobody's
  // elsewhere, which is what the stored column produced.
  const mine = store.listSettlements({ payers: ["0xagent"] }, null, 10);
  assert.deepEqual(
    mine.rows.map((r) => r.block_number),
    [13],
  );
  assert.equal(store.countSettlements({ payers: ["0xAGENT"] }), 1); // case-insensitive

  const scoped = store.listSettlements({ handle: "gadgethub-sg", payers: ["0xagent"] }, null, 10);
  assert.equal(scoped.rows.length, 1);
  assert.equal(store.countSettlements({ handle: "ah-hock-chicken-rice" }), 3);
});

test("a filter that names nobody is refused, never widened to every row", () => {
  // The invisible failure: `{ handle: "" }` and `{ payers: [] }` under a
  // truthiness check drop their WHERE clause and return the whole rail —
  // strangers' takings under one merchant's name, strangers' payments in
  // someone's activity feed. The route validates too, but this is the store's
  // public surface, so it has to refuse on its own.
  for (const filter of [{ handle: "" }, { payers: [] }, { handle: "", payers: ["0xagent"] }]) {
    assert.throws(
      () => store.listSettlements(filter, null, 10),
      `list must refuse ${JSON.stringify(filter)}`,
    );
    assert.throws(
      () => store.countSettlements(filter),
      `count must refuse ${JSON.stringify(filter)}`,
    );
  }

  // Absent still means "every row" — that is the dashboard's unscoped feed, and
  // refusing it would be the opposite mistake.
  assert.equal(store.listSettlements({}, null, 10).rows.length > 0, true);
  assert.equal(store.countSettlements({}), 5);
});

test("agent wallets are keyed by wallet, scoped to a factory, and never rewritten", () => {
  const FACTORY = "0xFacT0000000000000000000000000000000000A1";
  store.insertAgentWallet({
    wallet: "0xAaA0000000000000000000000000000000000001",
    owner: "0xOwNeR000000000000000000000000000000000A",
    agent_signer: "0xSiGnEr00000000000000000000000000000000B",
    block_number: 45_300_000,
    factory: FACTORY,
  });
  // The same log seen again by the other delivery path. INSERT OR IGNORE, because
  // a WalletCreated log is immutable history — a re-sweep must be a no-op, not a
  // rewrite that could clobber a row with a stale re-decode.
  store.insertAgentWallet({
    wallet: "0xaaa0000000000000000000000000000000000001",
    owner: "0x0000000000000000000000000000000000000bad",
    agent_signer: "0x0000000000000000000000000000000000000bad",
    block_number: 99_999_999,
    factory: FACTORY,
  });
  const rows = store.agentWalletsBySigner("0xsigner00000000000000000000000000000000b", FACTORY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.wallet, "0xaaa0000000000000000000000000000000000001");
  assert.equal(rows[0]?.block_number, 45_300_000, "the first sighting wins");

  // A wallet from a RETIRED factory is not a candidate. It still answers
  // owner()/policy() perfectly, so it would list as healthy — while its immutable
  // CORE is the dead core and every payment through it reverts.
  store.insertAgentWallet({
    wallet: "0xB0B0000000000000000000000000000000000002",
    owner: "0xOwNeR000000000000000000000000000000000A",
    agent_signer: "0xSiGnEr00000000000000000000000000000000B",
    block_number: 45_100_000,
    factory: "0xDeAd000000000000000000000000000000000009",
  });
  assert.equal(
    store.agentWalletsBySigner("0xsigner00000000000000000000000000000000b", FACTORY).length,
    1,
    "the retired factory's wallet is not offered",
  );
});

test("denials record the cancel tx, never a reverted one", () => {
  store.insertDenial({
    intent_id: "0xDeniedIntent",
    handle: "gadgethub-sg",
    merchant_id: "0xMerchant2",
    wallet: "0xPbmWallet",
    token_in: "0xToken",
    amount_in: "2980405",
    xsgd_amount: "4000000",
    error_name: "CategoryNotAllowed",
    error_args: JSON.stringify({ categoryId: 2 }),
    // The policy revert is caught in simulation and never broadcast, so the
    // only real tx is the one that cancelled the intent.
    cancel_tx: "0xCancelTx",
    created_at: 1_785_900_200,
  });
  const rows = store.listDenials("0xpbmwallet");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.error_name, "CategoryNotAllowed");
  assert.equal(rows[0]?.intent_id, "0xdeniedintent");
  assert.equal(store.countDenials("0xPBMWALLET"), 1);
});

test("merchants are keyed by id, lowercased on write, and never rewritten", () => {
  store.insertMerchant({
    merchant_id: "0xMerChantAhHock",
    handle: "Ah-Hock-Chicken-Rice",
    category_id: 1,
    display_name: "Ah Hock Chicken Rice",
    location: "Maxwell Food Centre",
    blurb: "Hainanese chicken rice since 1987.",
    block_number: 45_330_000,
    block_time: 1_785_900_500,
  });
  // The same registration log, redelivered by the other path. OR IGNORE: it is
  // immutable history, and a rewrite here would clobber the profile a later
  // MerchantProfileUpdated has already applied on top of it.
  store.insertMerchant({
    merchant_id: "0xmerchantahhock",
    handle: "ah-hock-chicken-rice",
    category_id: 9,
    display_name: "clobbered",
    location: "clobbered",
    blurb: "clobbered",
    block_number: 99_999_999,
    block_time: 0,
  });

  const row = store.getMerchantRow("AH-HOCK-CHICKEN-RICE"); // a mixed-case lookup must hit
  assert.equal(row?.merchant_id, "0xmerchantahhock");
  assert.equal(row?.handle, "ah-hock-chicken-rice");
  assert.equal(row?.category_id, 1, "the first sighting wins");
  assert.equal(row?.block_time, 1_785_900_500, "the registration date is not rewritten");
  // The load-bearing one: the indexer's own registration branch inserts EMPTY
  // display text (the profile arrives on a second log), so a re-sweep that
  // rewrote rather than ignored would blank a named shop.
  assert.equal(row?.display_name, "Ah Hock Chicken Rice");
});

test("setMerchantProfileRow rewrites only the display text", () => {
  store.setMerchantProfileRow("0xMerChantAhHock", {
    display_name: "Ah Hock Chicken Rice & Kopi",
    location: "Maxwell Food Centre #01-32",
    blurb: "Now with kopi.",
  });
  const row = store.getMerchantRow("ah-hock-chicken-rice");
  assert.equal(row?.display_name, "Ah Hock Chicken Rice & Kopi");
  assert.equal(row?.location, "Maxwell Food Centre #01-32");
  assert.equal(row?.category_id, 1, "an edit cannot move a merchant's category");
  assert.equal(row?.block_number, 45_330_000, "nor re-date its registration");

  // A profile event for an id with no row is a no-op, not an insert: the event
  // carries no handle, category or block, so a row minted from it would be a
  // merchant with no identity. registerMerchant emits both in one transaction,
  // so in practice the row always exists first.
  store.setMerchantProfileRow("0xnosuchmerchant", {
    display_name: "Ghost",
    location: "",
    blurb: "",
  });
  assert.equal(store.countMerchants(), 1);
});

test("listMerchants orders by registration, oldest first", () => {
  // Deliberately inserted newest-first, and out of handle order within a block,
  // so a table that happened to return insertion order would fail here.
  store.insertMerchant({
    merchant_id: "0xmerchantkopi",
    handle: "kopi-corner-sg",
    category_id: 1,
    display_name: "Kopi Corner",
    location: "Tiong Bahru",
    blurb: "",
    block_number: 45_340_000,
    block_time: 1_785_901_000,
  });
  store.insertMerchant({
    merchant_id: "0xmerchantgadget",
    handle: "gadgethub-sg",
    category_id: 2,
    display_name: "GadgetHub SG",
    location: "Sim Lim Square",
    blurb: "Cables and chargers.",
    block_number: 45_340_000,
    block_time: 1_785_901_000,
  });

  assert.deepEqual(
    store.listMerchants().map((m) => m.handle),
    ["ah-hock-chicken-rice", "gadgethub-sg", "kopi-corner-sg"],
  );
  assert.equal(store.countMerchants(), 3);

  // The cap is a backstop, and a caller comparing these two is how a truncated
  // list announces itself instead of passing for the whole rail.
  assert.equal(store.listMerchants(2).length, 2);
  assert.equal(store.countMerchants(), 3);
});

test("the merchants table holds no payout column", () => {
  // The directory is a public read surface. A shop's identity being public does
  // not make its money public, and nothing can leak a field the store never
  // held — so this is enforced by the schema rather than by every future screen
  // remembering. `getMerchant` reads payout live from the chain instead.
  const cols = store.db.prepare("PRAGMA table_info(merchants)").all() as { name: string }[];
  assert.ok(cols.length > 0, "the merchants table must exist");
  assert.ok(!cols.some((c) => c.name === "payout"), "payout must not be stored");
});

const SIGNER = "0xsigner00000000000000000000000000000000b";
const FACTORY = "0xFacT0000000000000000000000000000000000A1";

test("the store has no way to clear or hide a row", () => {
  // The property the single deploy block exists for: this cache is a pure
  // projection of the chain, so any host that has swept the same range holds
  // the same rows. Every mechanism that made one host's view differ — the old
  // `clearCache` + cursor jump, and the display floor that replaced it — was
  // removed, because per-host emptiness cannot coexist with hosts agreeing.
  // A clean book comes from deploying a fresh core, never from local state.
  const surface = store as unknown as Record<string, unknown>;
  for (const gone of ["clearCache", "getDisplayFloor", "setDisplayFloor"]) {
    assert.equal(surface[gone], undefined, `${gone} must not come back`);
  }

  // Everything written across this file is still readable, unfiltered.
  store.setCursor(45_065_094n);
  assert.equal(store.countSettlements({}), 5);
  assert.equal(store.countDenials("0xpbmwallet"), 1);
  assert.equal(store.getIntentRow("0xabcdef")?.settle_tx, "0xsettletx");
  assert.equal(store.agentWalletsBySigner(SIGNER, FACTORY).length, 1);
  assert.equal(store.getCursor(), 45_065_094n);

  // The two SSE paths see the whole book too — a reconnecting dashboard is not
  // a second place emptiness could be decided.
  assert.equal(store.recentSettlements().length, 5);
  assert.equal(store.settlementsAfter(9, 0).length, 5);
});
