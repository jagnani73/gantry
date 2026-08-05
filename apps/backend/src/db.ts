import Database from "better-sqlite3";
import { config } from "./config";

/** Cache only — chain is the source of truth. Deleting the file is a valid migration. */
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS intents (
    intent_id    TEXT PRIMARY KEY,
    merchant_id  TEXT NOT NULL,
    handle       TEXT NOT NULL,
    token_in     TEXT NOT NULL,
    amount_in    TEXT NOT NULL,
    xsgd_amount  TEXT NOT NULL,
    rate         TEXT NOT NULL,
    expiry       INTEGER NOT NULL,
    door         INTEGER NOT NULL,
    status       TEXT NOT NULL,
    valid_before INTEGER NOT NULL,
    created_tx   TEXT,
    settle_tx    TEXT,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settlements (
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    intent_id    TEXT NOT NULL,
    merchant_id  TEXT NOT NULL,
    handle       TEXT NOT NULL,
    payer        TEXT NOT NULL,
    token_in     TEXT NOT NULL,
    amount_in    TEXT NOT NULL,
    xsgd_out     TEXT NOT NULL,
    fee_xsgd     TEXT NOT NULL,
    door         INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    block_time   INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
  );

  CREATE INDEX IF NOT EXISTS idx_settlements_block ON settlements (block_number, log_index);
`);

export interface IntentRow {
  intent_id: string;
  merchant_id: string;
  handle: string;
  token_in: string;
  amount_in: string;
  xsgd_amount: string;
  rate: string;
  expiry: number;
  door: number;
  status: string;
  valid_before: number;
  created_tx: string | null;
  settle_tx: string | null;
  created_at: number;
}

export interface SettlementRow {
  tx_hash: string;
  log_index: number;
  intent_id: string;
  merchant_id: string;
  handle: string;
  payer: string;
  token_in: string;
  amount_in: string;
  xsgd_out: string;
  fee_xsgd: string;
  door: number;
  block_number: number;
  block_time: number;
}

const insertIntentStmt = db.prepare(`
  INSERT OR REPLACE INTO intents (
    intent_id, merchant_id, handle, token_in, amount_in, xsgd_amount, rate,
    expiry, door, status, valid_before, created_tx, settle_tx, created_at
  ) VALUES (
    @intent_id, @merchant_id, @handle, @token_in, @amount_in, @xsgd_amount, @rate,
    @expiry, @door, @status, @valid_before, @created_tx, @settle_tx, @created_at
  )
`);
const getIntentStmt = db.prepare<[string], IntentRow>("SELECT * FROM intents WHERE intent_id = ?");
const setIntentStatusStmt = db.prepare(
  "UPDATE intents SET status = ?, settle_tx = COALESCE(?, settle_tx) WHERE intent_id = ?",
);

export function insertIntentRow(row: IntentRow): void {
  insertIntentStmt.run(row);
}

export function getIntentRow(intentId: string): IntentRow | undefined {
  return getIntentStmt.get(intentId.toLowerCase());
}

export function setIntentStatus(intentId: string, status: string, settleTx?: string): void {
  setIntentStatusStmt.run(status, settleTx ?? null, intentId.toLowerCase());
}

const getMetaStmt = db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?");
const setMetaStmt = db.prepare(
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

export function getCursor(): bigint | null {
  const row = getMetaStmt.get("last_processed_block");
  return row ? BigInt(row.value) : null;
}

export function setCursor(block: bigint): void {
  setMetaStmt.run("last_processed_block", block.toString());
}
