import Database from "better-sqlite3";
import { Door } from "@gantry/shared";

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
 * An agent payment the PBM wallet refused.
 *
 * The policy revert itself is caught by simulate-before-send and never
 * broadcast, and a reverted transaction carries no logs anyway — so the refusal
 * rides on the CANCEL, which succeeds. `GantryCore.cancelIntentWithReason`
 * emits `IntentDenied` and the indexer sweeps it, so this row is chain-derived
 * on every host rather than living only on the backend that refused the
 * payment. `cancel_tx` is that cancellation, not a reverted settle: there is
 * still no such thing.
 *
 * One row can be written locally instead: when the cancel does not land there is
 * no event to sweep, so `services/pbm.ts` writes a fallback with `cancel_tx`
 * null rather than losing the refusal entirely. The sweep replaces it in place if
 * the cancel turns out to have mined.
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
 * One registered merchant, as the core's own logs report it — the index behind
 * the public directory and behind every registration date.
 *
 * There is deliberately NO `payout` column, and its absence is the feature: the
 * directory is a public read surface, and a shop's identity being public does
 * not make its money public. Nothing can leak a field the store never held, so
 * the rule survives whoever writes the next screen. `getMerchant` reads payout
 * live from the chain, where it belongs — a rotated payout would make a cached
 * one wrong anyway.
 *
 * Registration facts (`handle`, `category_id`, `block_*`) are immutable, so the
 * insert is `OR IGNORE`. The three profile strings are not: `setMerchantProfile`
 * rewrites them, and `MerchantProfileUpdated` fires on both register and edit —
 * which is why an indexer following ONE event always holds the current text.
 *
 * They are stored RAW, exactly as the chain carries them. `registerMerchant` is
 * permissionless and the contract checks length only, so the sanitising belongs
 * on the read path (`resolveProfile`) where it applies to every consumer,
 * including rows written before a rule existed.
 */
export interface MerchantRow {
  merchant_id: string;
  handle: string;
  category_id: number;
  display_name: string;
  location: string;
  blurb: string;
  block_number: number;
  /** Unix seconds of the registration block — the registration date itself. */
  block_time: number;
}

/**
 * Bounds one directory response. The rail is far smaller than this and the page
 * filters client-side over everything it loaded, so the cap is a backstop rather
 * than pagination — but a truncated list must ANNOUNCE itself, which is what
 * `countMerchants` beside it is for.
 *
 * Not exported past this module on purpose: the client detects truncation by
 * comparing `total` against the rows it received, so nothing outside needs to
 * know the number, and a client that knew it would be tempted to assume it.
 */
const MERCHANT_LIST_LIMIT = 500;

/**
 * Filters shared by the settlement list and its total-count sibling. Omit a key
 * to match every row on that dimension; a key that is present but names nobody
 * is REFUSED (see `settlementWhere`), because widening it is invisible.
 */
export interface SettlementFilter {
  handle?: string;
  /**
   * Lowercased on-chain payers. One query therefore covers "me and my agents"
   * for the payer app, which passes its own address AND its wallets — a PBM
   * payment's payer is the wallet, not the human.
   *
   * It no longer also matches an `agentPayer`: see `SettlementEvent.bridged`.
   * A bridged x402 row's on-chain payer is the relayer and the buyer's address
   * is nowhere on-chain, so that arm could only ever match on the one backend
   * that performed the hop.
   */
  payers?: string[];
}

/**
 * Mostly a cache, and it is worth knowing exactly which tables are which.
 *
 * SWEPT from the chain, so any two hosts that have covered the same range hold
 * identical rows — that is the whole reason the contracts are deployed together
 * and share one `BASE_SEPOLIA_DEPLOY_BLOCK`:
 *   - `settlements` (IntentSettled), `agent_wallets` (WalletCreated),
 *     `denials` (IntentDenied, on the cancel — see `DenialRow`),
 *     `merchants` (MerchantRegistered + MerchantProfileUpdated)
 *
 * BACKEND-WRITTEN, so it exists only on the host that did the work:
 *   - `intents` — `IntentCreated` exists but is deliberately not swept; the row
 *     carries the requote path and the stored validBefore, and settlement
 *     rebuilds the parts that matter from the event.
 *
 * `denials` has one backend-written case left: a refusal whose CANCEL failed
 * emits no event, so the row is written locally with a null `cancel_tx` rather
 * than lost. That is the only way two hosts can now disagree about a refusal,
 * and it is a failure path rather than the normal one.
 *
 * There is deliberately no runtime "clear" or "reset". Deleting the file is the
 * valid migration, and a clean book comes from deploying a fresh core —
 * `pnpm contracts:fresh` — which every host then indexes from.
 */
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
     * Nothing in this file is ever deleted at runtime. This table, settlements
     * and denials are what the sweep rebuilds from the chain, so any host
     * covering the same range holds the same rows; dropping the file and letting
     * it backfill is the only "reset" there is. (intents does NOT come back that
     * way — see the header comment.)
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

    /*
     * Every merchant the core has registered — see MerchantRow for why there is
     * no payout column here and why the profile text is stored raw.
     *
     * Swept in the same getLogs windows as everything above: the sweep already
     * reads the core's address every pass, and viem compiles the event list into
     * one topic0 OR-filter, so these two events cost no extra RPC calls at all.
     * That is also what retired the separate bounded log walk this backend used
     * to run just to date a registration — it re-covered ground the sweep had
     * already walked, and lost its answers on every restart.
     */
    CREATE TABLE IF NOT EXISTS merchants (
      merchant_id  TEXT PRIMARY KEY,
      handle       TEXT NOT NULL,
      category_id  INTEGER NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      location     TEXT NOT NULL DEFAULT '',
      blurb        TEXT NOT NULL DEFAULT '',
      block_number INTEGER NOT NULL,
      block_time   INTEGER NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_denials_wallet ON denials (wallet, created_at DESC);
    -- The agent CLI knows only its own session key, so this is the lookup that
    -- lets it find the wallets it acts for.
    CREATE INDEX IF NOT EXISTS idx_agent_wallets_signer ON agent_wallets (agent_signer);
    -- UNIQUE states the contract's own invariant: merchantId is keccak(handle),
    -- so one handle can never belong to two merchants. It also makes the profile
    -- edit and every by-handle lookup an index seek.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_handle ON merchants (handle);
    -- The directory's only order: registration, oldest first. Handle breaks ties
    -- so two shops registered in one block never swap places between requests.
    CREATE INDEX IF NOT EXISTS idx_merchants_order ON merchants (block_number, handle);
  `);

  // The cache is disposable, but ALTER beats deleting a db mid-demo: bring an
  // older file up to the current shape in place. A DROPPED column needs no
  // migration — every statement here names its columns explicitly, so a
  // vestigial nullable `agent_payer` on a pre-existing file is simply never
  // read or written again.
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
      expiry, door, status, valid_before, created_tx, settle_tx, created_at
    ) VALUES (
      @intent_id, @merchant_id, @handle, @token_in, @amount_in, @xsgd_amount, @rate,
      @expiry, @door, @status, @valid_before, @created_tx, @settle_tx, @created_at
    )
  `);
  const getIntentStmt = db.prepare<[string], IntentRow>(
    "SELECT * FROM intents WHERE intent_id = ?",
  );
  const setIntentStatusStmt = db.prepare(
    "UPDATE intents SET status = ?, settle_tx = COALESCE(?, settle_tx) WHERE intent_id = ?",
  );
  const insertSettlementStmt = db.prepare(`
    INSERT OR IGNORE INTO settlements (
      tx_hash, log_index, intent_id, merchant_id, handle, payer, token_in,
      amount_in, xsgd_out, fee_xsgd, door, block_number, block_time
    ) VALUES (
      @tx_hash, @log_index, @intent_id, @merchant_id, @handle, @payer, @token_in,
      @amount_in, @xsgd_out, @fee_xsgd, @door, @block_number, @block_time
    )
  `);
  const recentSettlementsStmt = db.prepare<[number], SettlementRow>(
    "SELECT * FROM (SELECT * FROM settlements ORDER BY block_number DESC, log_index DESC LIMIT ?) ORDER BY block_number ASC, log_index ASC",
  );
  const settlementsAfterStmt = db.prepare<[number, number, number], SettlementRow>(
    "SELECT * FROM settlements WHERE (block_number > ?) OR (block_number = ? AND log_index > ?) ORDER BY block_number ASC, log_index ASC",
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
  const listDenialsStmt = db.prepare<[string, number], DenialRow>(
    "SELECT * FROM denials WHERE wallet = ? ORDER BY created_at DESC LIMIT ?",
  );
  const countDenialsStmt = db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM denials WHERE wallet = ?",
  );
  // `OR IGNORE` for the same reason WalletCreated uses it: a registration log is
  // immutable history, the watch and the sweep deliver it twice by design, and a
  // rewrite would clobber the profile a later MerchantProfileUpdated had already
  // applied on top of it.
  const insertMerchantStmt = db.prepare(`
    INSERT OR IGNORE INTO merchants (
      merchant_id, handle, category_id, display_name, location, blurb,
      block_number, block_time
    ) VALUES (
      @merchant_id, @handle, @category_id, @display_name, @location, @blurb,
      @block_number, @block_time
    )
  `);
  // Keyed on merchant_id because that is ALL the event carries: the three
  // strings are unindexed data and the handle is not on it at all. A no-op for
  // an id with no row is correct — registerMerchant emits both events in one
  // transaction, so the row exists before any edit can refer to it.
  const setMerchantProfileStmt = db.prepare(
    "UPDATE merchants SET display_name = ?, location = ?, blurb = ? WHERE merchant_id = ?",
  );
  const getMerchantStmt = db.prepare<[string], MerchantRow>(
    "SELECT * FROM merchants WHERE handle = ?",
  );
  const listMerchantsStmt = db.prepare<[number], MerchantRow>(
    "SELECT * FROM merchants ORDER BY block_number ASC, handle ASC LIMIT ?",
  );
  const countMerchantsStmt = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM merchants");

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
    const clauses: string[] = [];
    const params: unknown[] = [];
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
      clauses.push(`payer IN (${holes})`);
      params.push(...lowered);
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

    /** Returns true when the row is new (dedup across watch + sweep paths). */
    insertSettlementRow(row: SettlementRow): boolean {
      return (
        insertSettlementStmt.run({
          ...row,
          intent_id: row.intent_id.toLowerCase(),
          merchant_id: row.merchant_id.toLowerCase(),
          payer: row.payer.toLowerCase(),
          token_in: row.token_in.toLowerCase(),
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

    /**
     * Totals over every matching row from `sinceUnixSeconds` (INCLUSIVE), for
     * the merchant Overview's tiles — see `SettlementSummaryResponse`.
     *
     * Two details in the SQL are load-bearing:
     *
     * `CAST(x AS INTEGER)` because the amount columns are TEXT. They hold 6dp
     * unit integers as decimal strings, so the cast is exact — but SUM over TEXT
     * would coerce through REAL and start rounding a takings figure at the
     * fifteenth digit. The result is cast back to TEXT so it reaches the wire as
     * the decimal string every other amount is, rather than as a JS number that
     * silently rounds past 2^53.
     *
     * `latest` deliberately IGNORES the `since` bound: it is the newest matching
     * row, not the newest row in the window. A client folds a live row into
     * these totals only when its position is after this mark, so during a month
     * whose window is still empty the mark has to be the last row from BEFORE it
     * — otherwise a null mark would let the client re-add rows it had already
     * counted. Its ordering mirrors `listSettlements`, and `isAfterCursor` in
     * shared mirrors it a third time; all three have to agree.
     */
    sumSettlements(
      filter: SettlementFilter,
      sinceUnixSeconds: number,
    ): {
      count: number;
      gross: string;
      fees: string;
      agentCount: number;
      latest: { blockNumber: number; logIndex: number } | null;
    } {
      const { sql: where, params } = settlementWhere(filter);
      const totals = prepared(
        `SELECT
           COUNT(*) AS count,
           CAST(COALESCE(SUM(CAST(xsgd_out AS INTEGER)), 0) AS TEXT) AS gross,
           CAST(COALESCE(SUM(CAST(fee_xsgd AS INTEGER)), 0) AS TEXT) AS fees,
           COALESCE(SUM(CASE WHEN door = ? THEN 1 ELSE 0 END), 0) AS agentCount
         FROM settlements ${where} ${where ? "AND" : "WHERE"} block_time >= ?`,
      ).get(Door.Agent, ...params, sinceUnixSeconds) as {
        count: number;
        gross: string;
        fees: string;
        agentCount: number;
      };
      const newest = prepared(
        `SELECT block_number, log_index FROM settlements ${where}
         ORDER BY block_number DESC, log_index DESC LIMIT 1`,
      ).get(...params) as { block_number: number; log_index: number } | undefined;
      return {
        ...totals,
        latest: newest ? { blockNumber: newest.block_number, logIndex: newest.log_index } : null,
      };
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
      return listDenialsStmt.all(wallet.toLowerCase(), limit);
    },

    countDenials(wallet: string): number {
      return countDenialsStmt.get(wallet.toLowerCase())?.n ?? 0;
    },

    /** Registration facts, written once. Ids and the handle lowercase on write
     * like every other id column — `merchant_id` is a keccak hash, for which
     * lowercase already IS canonical, and handles are lowercase on-chain. */
    insertMerchant(row: MerchantRow): void {
      insertMerchantStmt.run({
        ...row,
        merchant_id: row.merchant_id.toLowerCase(),
        handle: row.handle.toLowerCase(),
      });
    },

    /** The display text, from `MerchantProfileUpdated`. Stored raw — see
     * MerchantRow; sanitising happens on the way out. */
    setMerchantProfileRow(
      merchantId: string,
      profile: { display_name: string; location: string; blurb: string },
    ): void {
      setMerchantProfileStmt.run(
        profile.display_name,
        profile.location,
        profile.blurb,
        merchantId.toLowerCase(),
      );
    },

    /** Present only once the sweep has crossed the registration block. Absent is
     * "not indexed yet", never "no such merchant" — the chain read decides that. */
    getMerchantRow(handle: string): MerchantRow | undefined {
      return getMerchantStmt.get(handle.toLowerCase());
    },

    /** The whole directory, oldest registration first. Capped — compare the
     * length against `countMerchants` before presenting it as everything. */
    listMerchants(limit = MERCHANT_LIST_LIMIT): MerchantRow[] {
      return listMerchantsStmt.all(limit);
    },

    countMerchants(): number {
      return countMerchantsStmt.get()?.n ?? 0;
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
