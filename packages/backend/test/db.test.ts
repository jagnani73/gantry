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
    agent_payer: null,
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
    agent_payer: null,
  };
  store.insertIntentRow(row);
  const got = store.getIntentRow("0xAbCdEf"); // checksummed lookup must hit
  assert.equal(got?.intent_id, "0xabcdef");
  assert.equal(got?.token_in, "0xtoken");
});

test("setIntentAgentPayer records the bridged x402 payer lowercased", () => {
  store.setIntentAgentPayer("0xABCDEF", "0xAgentPayer");
  assert.equal(store.getIntentRow("0xabcdef")?.agent_payer, "0xagentpayer");
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

test("payer filter matches the on-chain payer OR the bridged agent payer", () => {
  // A vanilla x402 payment settles with the relayer as on-chain payer and the
  // agent recorded separately — the payer app must still find it as "mine".
  store.insertSettlementRow(
    settlement(12, 0, { payer: "0xRelayer", agent_payer: "0xAgent", handle: "gadgethub-sg" }),
  );
  store.insertSettlementRow(settlement(13, 0, { payer: "0xAgent", handle: "gadgethub-sg" }));

  const mine = store.listSettlements({ payers: ["0xagent"] }, null, 10);
  assert.deepEqual(
    mine.rows.map((r) => r.block_number),
    [13, 12],
  );
  assert.equal(store.countSettlements({ payers: ["0xAGENT"] }), 2); // case-insensitive

  const scoped = store.listSettlements({ handle: "gadgethub-sg", payers: ["0xagent"] }, null, 10);
  assert.equal(scoped.rows.length, 2);
  assert.equal(store.countSettlements({ handle: "ah-hock-chicken-rice" }), 3);
});

test("merchant profiles upsert in place and survive a cache clear", () => {
  store.upsertMerchantProfile({
    handle: "Ah-Hock-Chicken-Rice",
    display_name: "Ah Hock Chicken Rice",
    location: "Maxwell Food Centre #01-32",
    blurb: "Hainanese chicken rice since 1987.",
    updated_at: 1_785_900_000,
  });
  store.upsertMerchantProfile({
    handle: "ah-hock-chicken-rice",
    display_name: "Ah Hock Chicken Rice",
    location: "Maxwell Food Centre #01-33",
    blurb: "Hainanese chicken rice since 1987.",
    updated_at: 1_785_900_100,
  });
  const got = store.getMerchantProfile("ah-hock-chicken-rice");
  assert.equal(got?.location, "Maxwell Food Centre #01-33");
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

test("clearCache empties transaction tables but keeps merchant identity", () => {
  store.setCursor(45_065_094n);
  store.clearCache();
  assert.deepEqual(store.recentSettlements(), []);
  assert.equal(store.getIntentRow("0xabcdef"), undefined);
  assert.equal(store.countDenials("0xpbmwallet"), 0);
  assert.equal(store.getCursor(), 45_065_094n);
  // Identity is the one thing here the chain cannot re-supply, so a reset that
  // erased it would lose a shop that onboarded live.
  assert.equal(store.getMerchantProfile("ah-hock-chicken-rice")?.display_name, "Ah Hock Chicken Rice");
});
