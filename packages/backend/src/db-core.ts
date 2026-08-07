import Database from "better-sqlite3";

/** Statuses ever STORED — "expired"/"unknown" are computed at read time, never written. */
export type DbIntentStatus = "pending" | "settled" | "cancelled";

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
  status: DbIntentStatus;
  valid_before: number;
  created_tx: string | null;
  settle_tx: string | null;
  created_at: number;
  /** x402 payer behind a facilitator-bridged intent (on-chain payer = relayer). */
  agent_payer: string | null;
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
  agent_payer: string | null;
}

/** Cache only — chain is the source of truth. Deleting the file is a valid
 * migration (in-flight intents lose the requote path and the stored
 * validBefore fallback until re-created). */
export function createDatabase(path: string) {
  const db = new Database(path);
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
      created_at   INTEGER NOT NULL,
      agent_payer  TEXT
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
      agent_payer  TEXT,
      PRIMARY KEY (tx_hash, log_index)
    );

    CREATE INDEX IF NOT EXISTS idx_settlements_block ON settlements (block_number, log_index);
  `);

  // The cache is disposable, but ALTER beats deleting a db mid-demo: bring
  // pre-M2 files up to the current shape in place.
  for (const table of ["intents", "settlements"]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "agent_payer")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN agent_payer TEXT`);
    }
  }

  const insertIntentStmt = db.prepare(`
    INSERT OR REPLACE INTO intents (
      intent_id, merchant_id, handle, token_in, amount_in, xsgd_amount, rate,
      expiry, door, status, valid_before, created_tx, settle_tx, created_at, agent_payer
    ) VALUES (
      @intent_id, @merchant_id, @handle, @token_in, @amount_in, @xsgd_amount, @rate,
      @expiry, @door, @status, @valid_before, @created_tx, @settle_tx, @created_at, @agent_payer
    )
  `);
  const getIntentStmt = db.prepare<[string], IntentRow>(
    "SELECT * FROM intents WHERE intent_id = ?",
  );
  const setIntentStatusStmt = db.prepare(
    "UPDATE intents SET status = ?, settle_tx = COALESCE(?, settle_tx) WHERE intent_id = ?",
  );
  const setIntentAgentPayerStmt = db.prepare(
    "UPDATE intents SET agent_payer = ? WHERE intent_id = ?",
  );
  const insertSettlementStmt = db.prepare(`
    INSERT OR IGNORE INTO settlements (
      tx_hash, log_index, intent_id, merchant_id, handle, payer, token_in,
      amount_in, xsgd_out, fee_xsgd, door, block_number, block_time, agent_payer
    ) VALUES (
      @tx_hash, @log_index, @intent_id, @merchant_id, @handle, @payer, @token_in,
      @amount_in, @xsgd_out, @fee_xsgd, @door, @block_number, @block_time, @agent_payer
    )
  `);
  const recentSettlementsStmt = db.prepare<[number], SettlementRow>(
    "SELECT * FROM (SELECT * FROM settlements ORDER BY block_number DESC, log_index DESC LIMIT ?) ORDER BY block_number ASC, log_index ASC",
  );
  const settlementsAfterStmt = db.prepare<[number, number, number], SettlementRow>(
    "SELECT * FROM settlements WHERE (block_number > ?) OR (block_number = ? AND log_index > ?) ORDER BY block_number ASC, log_index ASC",
  );
  const getMetaStmt = db.prepare<[string], { value: string }>(
    "SELECT value FROM meta WHERE key = ?",
  );
  const setMetaStmt = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  return {
    db,

    // Ids/addresses are normalized to lowercase HERE so a checksummed caller
    // can never cause a silent cache miss.
    insertIntentRow(row: IntentRow): void {
      insertIntentStmt.run({
        ...row,
        intent_id: row.intent_id.toLowerCase(),
        merchant_id: row.merchant_id.toLowerCase(),
        token_in: row.token_in.toLowerCase(),
      });
    },

    getIntentRow(intentId: string): IntentRow | undefined {
      return getIntentStmt.get(intentId.toLowerCase());
    },

    setIntentStatus(intentId: string, status: DbIntentStatus, settleTx?: string): void {
      setIntentStatusStmt.run(status, settleTx ?? null, intentId.toLowerCase());
    },

    setIntentAgentPayer(intentId: string, agentPayer: string): void {
      setIntentAgentPayerStmt.run(agentPayer.toLowerCase(), intentId.toLowerCase());
    },

    /** Returns true when the row is new (dedup across watch + sweep paths). */
    insertSettlementRow(row: SettlementRow): boolean {
      return (
        insertSettlementStmt.run({
          ...row,
          intent_id: row.intent_id.toLowerCase(),
          merchant_id: row.merchant_id.toLowerCase(),
          payer: row.payer.toLowerCase(),
          token_in: row.token_in.toLowerCase(),
          agent_payer: row.agent_payer?.toLowerCase() ?? null,
        }).changes > 0
      );
    },

    recentSettlements(limit = 20): SettlementRow[] {
      return recentSettlementsStmt.all(limit);
    },

    settlementsAfter(blockNumber: number, logIndex: number): SettlementRow[] {
      return settlementsAfterStmt.all(blockNumber, blockNumber, logIndex);
    },

    /** Admin reset: cache only — chain state is untouched and rebuildable. */
    clearCache(): void {
      db.exec("DELETE FROM settlements; DELETE FROM intents;");
    },

    getCursor(): bigint | null {
      const row = getMetaStmt.get("last_processed_block");
      return row ? BigInt(row.value) : null;
    },

    setCursor(block: bigint): void {
      setMetaStmt.run("last_processed_block", block.toString());
    },
  };
}
