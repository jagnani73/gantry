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
 * One `WalletCreated` log from the agent factory, as swept.
 *
 * A candidate, never a verdict: ownership is `Ownable2Step` and the agent signer
 * rotates, so this records who created a wallet and not who controls it now. The
 * live reads in `services/agents.ts` decide, which is also why nothing here is
 * ever rendered directly.
 */
export interface AgentWalletRow {
  wallet: string;
  owner: string;
  agent_signer: string;
  block_number: number;
  /** The factory that emitted the log. Reads filter on the current one. */
  factory: string;
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

/**
 * Rehearsal display floor: rows older than this are stored but not shown.
 *
 * `demo:reset` used to DELETE the transaction tables and jump the sweep cursor
 * to head so the deleted rows were never re-imported. That made a rehearsal a
 * destructive act on derived state — the local cache stopped being a faithful
 * projection of the chain, so a demo box and a deployed host could not hold the
 * same rows even in principle. It also created a standing trap: every
 * append-only table had to be remembered and exempted, and `agent_wallets`
 * needed exactly that carve-out.
 *
 * So emptiness became a RENDERING fact instead of a storage one. Nothing is
 * deleted, the cursor is never moved by hand, and both hosts converge on the
 * same rows from the same floor. What a reset writes is this marker, and the
 * read surfaces skip anything beneath it.
 *
 * Two dimensions because the two tables are dated differently: settlements
 * carry a `block_number` (chain order), denials carry a `created_at` (wall
 * clock) because a denial has no transaction to be mined in — see `DenialRow`.
 *
 * A missing or malformed marker means NO floor, i.e. show everything. Failing
 * open is deliberate: the failure is then visible (old rows on screen, which a
 * presenter notices) rather than invisible (an empty book, indistinguishable
 * from a broken feed).
 */
export interface DisplayFloor {
  /** Exclusive: a settlement shows when `block_number > block`. */
  block: number;
  /** Inclusive: a denial shows when `created_at >= at`. Unix seconds. */
  at: number;
}

/** Sentinels that match every row, so the floor is one bound parameter rather
 * than a second SQL shape per query. */
const NO_FLOOR_BLOCK = -1;
const NO_FLOOR_AT = 0;

const DISPLAY_FLOOR_KEY = "display_floor";

/**
 * Filters shared by the settlement list and its total-count sibling. Omit a key
 * to match every row on that dimension; a key that is present but names nobody
 * is REFUSED (see `settlementWhere`), because widening it is invisible.
 */
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

    /*
     * Agent wallets, as the factory's WalletCreated logs report them.
     *
     * Swept by the indexer alongside the core's own events — one getLogs pass over
     * two addresses — which replaced a separate chunked scanner that re-walked the
     * same block range on every cold process and died on a shared egress IP.
     *
     * Candidates ONLY. Ownership is Ownable2Step and the signer rotates, so a
     * creation log records who made a wallet, never who controls it now; the live
     * multicall in services/agents.ts decides.
     *
     * This table needed an explicit carve-out back when a reset DELETED rows and
     * jumped the cursor past them — append-only history, so nothing would have
     * looked for it again. A reset writes a display floor now (see DisplayFloor)
     * and destroys nothing, so that whole class of exemption is gone. A wallet is
     * hidden from a feed by its floor, never lost.
     */
    CREATE TABLE IF NOT EXISTS agent_wallets (
      wallet       TEXT PRIMARY KEY,
      owner        TEXT NOT NULL,
      agent_signer TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      -- Which factory minted it. Every read filters on the CURRENT one, because a
      -- redeploy makes older rows actively dangerous rather than merely stale: an
      -- old wallet answers owner()/policy() perfectly, so it lists as healthy, and
      -- its immutable CORE is the retired core — every payment through it reverts.
      -- Without this the only guard was remembering to delete the database.
      factory      TEXT NOT NULL DEFAULT ''
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
    -- The agent CLI knows only its own session key, so this is the lookup that
    -- lets it find the wallets it acts for.
    CREATE INDEX IF NOT EXISTS idx_agent_wallets_signer ON agent_wallets (agent_signer);
  `);

  // The cache is disposable, but ALTER beats deleting a db mid-demo: bring
  // pre-M2 files up to the current shape in place.
  for (const table of ["intents", "settlements"]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "agent_payer")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN agent_payer TEXT`);
    }
  }
  {
    const cols = db.prepare("PRAGMA table_info(agent_wallets)").all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === "factory")) {
      // Rows written before this column existed have unknown provenance, and the
      // default `''` matches no factory — so they stop being offered as candidates
      // rather than being trusted. The sweep re-adds any that are still current.
      db.exec("ALTER TABLE agent_wallets ADD COLUMN factory TEXT NOT NULL DEFAULT ''");
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
  // Both SSE paths carry the display floor. The LIVE stream does not need it —
  // a floor is written at the chain head, so anything broadcast afterwards is
  // above it by construction — but REPLAY does: a client reconnecting with a
  // `Last-Event-ID` from before a reset would otherwise be handed the very rows
  // the reset was meant to retire.
  const recentSettlementsStmt = db.prepare<[number, number], SettlementRow>(
    "SELECT * FROM (SELECT * FROM settlements WHERE block_number > ? ORDER BY block_number DESC, log_index DESC LIMIT ?) ORDER BY block_number ASC, log_index ASC",
  );
  const settlementsAfterStmt = db.prepare<[number, number, number, number], SettlementRow>(
    "SELECT * FROM settlements WHERE ((block_number > ?) OR (block_number = ? AND log_index > ?)) AND block_number > ? ORDER BY block_number ASC, log_index ASC",
  );
  // `OR IGNORE`, not `OR REPLACE`: a WalletCreated log is immutable history, so a
  // re-sweep of the same block must be a no-op rather than a rewrite. The watch and
  // the sweep overlap by design — the same reason settlements dedup on their PK.
  const insertAgentWalletStmt = db.prepare(`
    INSERT OR IGNORE INTO agent_wallets (wallet, owner, agent_signer, block_number, factory)
    VALUES (@wallet, @owner, @agent_signer, @block_number, @factory)
  `);
  const agentWalletsBySignerStmt = db.prepare<[string, string], AgentWalletRow>(
    "SELECT * FROM agent_wallets WHERE agent_signer = ? AND factory = ? ORDER BY block_number ASC",
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
  const listDenialsStmt = db.prepare<[string, number, number], DenialRow>(
    "SELECT * FROM denials WHERE wallet = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?",
  );
  const countDenialsStmt = db.prepare<[string, number], { n: number }>(
    "SELECT COUNT(*) AS n FROM denials WHERE wallet = ? AND created_at >= ?",
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

  /**
   * WHERE fragment + bound params shared by the list and count queries, so the
   * two can never disagree about what "matching" means.
   *
   * A key PRESENT but naming nobody (`{ handle: "" }`, `{ payers: [] }`) is
   * refused, never widened. A truthiness test here turns either into "every row
   * on the rail" — strangers' takings under one merchant's name, strangers'
   * payments in someone's activity feed — which is the exact failure
   * `parsePayerFilter` exists to prevent one layer up. The route validates too,
   * but this is the store's public surface and `SettlementReader` invites other
   * callers. Throwing is right rather than harsh: only a caller bug gets here,
   * and a 500 is visible where a widened feed is not.
   */
  function settlementWhere(filter: SettlementFilter): { sql: string; params: unknown[] } {
    // The floor is not a caller-supplied filter and is never optional: it is
    // applied here so the list and the count can no more disagree about the
    // rehearsal window than they can about the handle.
    const clauses: string[] = ["block_number > ?"];
    const params: unknown[] = [floorBlock()];
    if (filter.handle !== undefined) {
      if (filter.handle === "") throw new Error("settlement filter: handle is present but empty");
      clauses.push("handle = ?");
      params.push(filter.handle.toLowerCase());
    }
    if (filter.payers !== undefined) {
      if (filter.payers.length === 0) {
        throw new Error("settlement filter: payers is present but lists no addresses");
      }
      const holes = filter.payers.map(() => "?").join(", ");
      const lowered = filter.payers.map((a) => a.toLowerCase());
      clauses.push(`(payer IN (${holes}) OR agent_payer IN (${holes}))`);
      params.push(...lowered, ...lowered);
    }
    // Always a WHERE now — the floor clause is unconditional.
    return { sql: `WHERE ${clauses.join(" AND ")}`, params };
  }

  const getMetaStmt = db.prepare<[string], { value: string }>(
    "SELECT value FROM meta WHERE key = ?",
  );
  const setMetaStmt = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  /**
   * Stored as one `"<block>:<at>"` value rather than two meta rows, so the two
   * halves can never be read half-updated — a floor whose block moved but whose
   * timestamp did not would hide this run's settlements while showing the last
   * run's denials.
   *
   * Anything unparseable returns null, i.e. no floor. See `DisplayFloor` for why
   * that direction is the safe one.
   */
  function displayFloor(): DisplayFloor | null {
    const raw = getMetaStmt.get(DISPLAY_FLOOR_KEY)?.value;
    // Matched whole, not parsed leniently: `Number("")` is 0, so a truncated
    // `"45307715:"` would otherwise read as a valid floor at the epoch and hide
    // this run's settlements while showing every denial ever recorded.
    if (raw === undefined || !/^\d+:\d+$/.test(raw)) return null;
    const [blockPart, atPart] = raw.split(":");
    const block = Number(blockPart);
    const at = Number(atPart);
    // Past 2^53 the value SQLite compares against stops being the value we
    // parsed, so an unrepresentable floor is treated as no floor.
    if (!Number.isSafeInteger(block) || !Number.isSafeInteger(at)) return null;
    return { block, at };
  }

  const floorBlock = (): number => displayFloor()?.block ?? NO_FLOOR_BLOCK;
  const floorAt = (): number => displayFloor()?.at ?? NO_FLOOR_AT;

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
      return recentSettlementsStmt.all(floorBlock(), limit);
    },

    settlementsAfter(blockNumber: number, logIndex: number): SettlementRow[] {
      return settlementsAfterStmt.all(blockNumber, blockNumber, logIndex, floorBlock());
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
        ? "AND (block_number < ? OR (block_number = ? AND log_index < ?))"
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

    /** Lowercased on write, exactly like every other address column: these arrive
     * from a decoded log, a query string and a chain read, and only the last is
     * reliably checksummed. */
    insertAgentWallet(row: AgentWalletRow): void {
      insertAgentWalletStmt.run({
        wallet: row.wallet.toLowerCase(),
        owner: row.owner.toLowerCase(),
        agent_signer: row.agent_signer.toLowerCase(),
        block_number: row.block_number,
        factory: row.factory.toLowerCase(),
      });
    },

    /** Scoped to a factory, always. An unscoped read would hand a caller wallets
     * pinned to a retired core, which look healthy and revert on every payment. */
    agentWalletsBySigner(signer: string, factory: string): AgentWalletRow[] {
      return agentWalletsBySignerStmt.all(signer.toLowerCase(), factory.toLowerCase());
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
      return listDenialsStmt.all(wallet.toLowerCase(), floorAt(), limit);
    },

    countDenials(wallet: string): number {
      return countDenialsStmt.get(wallet.toLowerCase(), floorAt())?.n ?? 0;
    },

    /**
     * The rehearsal window this cache renders. Null until a reset writes one,
     * which is the state a deployed host stays in forever — it shows everything
     * it has swept, which is what a shop window should do.
     */
    getDisplayFloor(): DisplayFloor | null {
      return displayFloor();
    },

    /**
     * Admin reset: retire everything below this point from the READ surfaces.
     * Nothing is deleted and the sweep cursor is not touched, so the cache stays
     * a faithful projection of the chain and a later `getLogs` pass over the same
     * range produces the same rows on any host. See `DisplayFloor`.
     */
    setDisplayFloor(floor: DisplayFloor): void {
      setMetaStmt.run(DISPLAY_FLOOR_KEY, `${floor.block}:${floor.at}`);
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
