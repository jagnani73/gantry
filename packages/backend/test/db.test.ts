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

function settlement(block: number, logIndex: number): SettlementRow {
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

test("clearCache empties both tables; cursor survives", () => {
  store.setCursor(45_065_094n);
  store.clearCache();
  assert.deepEqual(store.recentSettlements(), []);
  assert.equal(store.getIntentRow("0xabcdef"), undefined);
  assert.equal(store.getCursor(), 45_065_094n);
});
