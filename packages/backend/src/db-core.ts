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

/**
 * A merchant's off-chain display record. The chain stores only handle/payout/
 * category, so name, location and blurb live here — the first thing in this
 * file that is NOT rebuildable from chain, which is why `clearCache` leaves it
 * alone and `demo-reset` re-seeds the canonical demo shops.
 */
export interface MerchantProfileRow {
  handle: string;
  display_name: string;
  location: string;
  blurb: string;
  updated_at: number;
}

/**
 * An agent payment the PBM wallet refused. The policy revert is caught by
 * simulate-before-send and NEVER broadcast, so no event exists and no log can
 * be swept — this row is the only trace the denial ever happened. `cancel_tx`
 * is the tx that cancelled the intent, not a reverted settle: there isn't one.
 */
export interface DenialRow {
  intent_id: string;
  handle: string;
  merchant_id: string;
  wallet: string;
  token_in: string;
  amount_in: string;
  xsgd_amount: string;
  error_name: string;
  /** JSON-encoded decoded revert args, or null when the revert carried none. */
  error_args: string | null;
  cancel_tx: string | null;
  created_at: number;
}

/** Filters shared by the settlement list and its total-count sibling. */
export interface SettlementFilter {
  handle?: string;
  /** Lowercased addresses; a row matches if `payer` OR `agent_payer` is in the
   * list. One query therefore covers "me and my agents" for the payer app. */
  payers?: string[];
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

    CREATE TABLE IF NOT EXISTS merchant_profiles (
      handle       TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      location     TEXT NOT NULL,
      blurb        TEXT NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS denials (
      intent_id    TEXT PRIMARY KEY,
      handle       TEXT NOT NULL,
      merchant_id  TEXT NOT NULL,
      wallet       TEXT NOT NULL,
      token_in     TEXT NOT NULL,
      amount_in    TEXT NOT NULL,
      xsgd_amount  TEXT NOT NULL,
      error_name   TEXT NOT NULL,
      error_args   TEXT,
      cancel_tx    TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_settlements_block ON settlements (block_number, log_index);
    -- The list endpoint pages newest-first and filters by shop or by payer, so
    -- every index carries the sort key: without it a 60-row page is a full scan
    -- plus a sort, on the same connection the indexer sweep is writing through.
    CREATE INDEX IF NOT EXISTS idx_settlements_handle
      ON settlements (handle, block_number DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS idx_settlements_payer
      ON settlements (payer, block_number DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS idx_settlements_agent_payer
      ON settlements (agent_payer, block_number DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS idx_denials_wallet ON denials (wallet, created_at DESC);
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
  const upsertMerchantProfileStmt = db.prepare(`
    INSERT INTO merchant_profiles (handle, display_name, location, blurb, updated_at)
    VALUES (@handle, @display_name, @location, @blurb, @updated_at)
    ON CONFLICT(handle) DO UPDATE SET
      display_name = excluded.display_name,
      location     = excluded.location,
      blurb        = excluded.blurb,
      updated_at   = excluded.updated_at
  `);
  const getMerchantProfileStmt = db.prepare<[string], MerchantProfileRow>(
    "SELECT * FROM merchant_profiles WHERE handle = ?",
  );
  const insertDenialStmt = db.prepare(`
    INSERT OR REPLACE INTO denials (
      intent_id, handle, merchant_id, wallet, token_in, amount_in, xsgd_amount,
      error_name, error_args, cancel_tx, created_at
    ) VALUES (
      @intent_id, @handle, @merchant_id, @wallet, @token_in, @amount_in, @xsgd_amount,
      @error_name, @error_args, @cancel_tx, @created_at
    )
  `);
  const listDenialsStmt = db.prepare<[string, number], DenialRow>(
    "SELECT * FROM denials WHERE wallet = ? ORDER BY created_at DESC LIMIT ?",
  );
  const countDenialsStmt = db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM denials WHERE wallet = ?",
  );

  // better-sqlite3 does not cache prepared statements, and the settlement list
  // builds its SQL from the filter — so cache by SQL text rather than re-parsing
  // the same handful of shapes on every request.
  type AnyStatement = Database.Statement<unknown[], unknown>;
  const stmtCache = new Map<string, AnyStatement>();
  function prepared(sql: string): AnyStatement {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare<unknown[], unknown>(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  /** WHERE fragment + bound params shared by the list and count queries, so the
   * two can never disagree about what "matching" means. */
  function settlementWhere(filter: SettlementFilter): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.handle) {
      clauses.push("handle = ?");
      params.push(filter.handle.toLowerCase());
    }
    if (filter.payers?.length) {
      const holes = filter.payers.map(() => "?").join(", ");
      const lowered = filter.payers.map((a) => a.toLowerCase());
      clauses.push(`(payer IN (${holes}) OR agent_payer IN (${holes}))`);
      params.push(...lowered, ...lowered);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

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

    /**
     * Newest-first page of settlements. `before` is an exclusive cursor — pass
     * the last row of the previous page. Reads one extra row internally so the
     * caller can tell "last page" from "exactly full page" without a second
     * query; the extra row is trimmed before returning.
     */
    listSettlements(
      filter: SettlementFilter,
      before: { blockNumber: number; logIndex: number } | null,
      limit: number,
    ): { rows: SettlementRow[]; hasMore: boolean } {
      const { sql: where, params } = settlementWhere(filter);
      const cursor = before
        ? `${where ? "AND" : "WHERE"} (block_number < ? OR (block_number = ? AND log_index < ?))`
        : "";
      const cursorParams = before
        ? [before.blockNumber, before.blockNumber, before.logIndex]
        : [];
      const rows = prepared(
        `SELECT * FROM settlements ${where} ${cursor} ORDER BY block_number DESC, log_index DESC LIMIT ?`,
      ).all(...params, ...cursorParams, limit + 1) as SettlementRow[];
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    /** Total matching rows, ignoring pagination — the sidebar nav counts. */
    countSettlements(filter: SettlementFilter): number {
      const { sql: where, params } = settlementWhere(filter);
      const row = prepared(`SELECT COUNT(*) AS n FROM settlements ${where}`).get(...params) as {
        n: number;
      };
      return row.n;
    },

    getMerchantProfile(handle: string): MerchantProfileRow | undefined {
      return getMerchantProfileStmt.get(handle.toLowerCase());
    },

    upsertMerchantProfile(row: MerchantProfileRow): void {
      upsertMerchantProfileStmt.run({ ...row, handle: row.handle.toLowerCase() });
    },

    /** Keyed by intent — a denied intent is cancelled and never retried, so a
     * second write for the same id is a redelivery, not a second denial. */
    insertDenial(row: DenialRow): void {
      insertDenialStmt.run({
        ...row,
        intent_id: row.intent_id.toLowerCase(),
        merchant_id: row.merchant_id.toLowerCase(),
        wallet: row.wallet.toLowerCase(),
        token_in: row.token_in.toLowerCase(),
      });
    },

    listDenials(wallet: string, limit = 50): DenialRow[] {
      return listDenialsStmt.all(wallet.toLowerCase(), limit);
    },

    countDenials(wallet: string): number {
      return countDenialsStmt.get(wallet.toLowerCase())?.n ?? 0;
    },

    /**
     * Admin reset: transaction cache only — chain state is untouched and
     * rebuildable. `merchant_profiles` is deliberately NOT cleared: it is the
     * one table holding facts the chain does not have, so wiping it would erase
     * a shop that onboarded live rather than just replaying what it can re-sweep.
     */
    clearCache(): void {
      db.exec("DELETE FROM settlements; DELETE FROM intents; DELETE FROM denials;");
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
