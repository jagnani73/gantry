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
