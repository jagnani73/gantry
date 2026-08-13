import type { Address, Hex } from "viem";
import {
  IntentStatus,
  LOG_CHUNK_SPAN,
  agentPbmWalletFactoryAbi,
  gantryCoreAbi,
  decodeRawError,
  tokenIdByAddress,
  type SettlementEvent,
} from "@gantry/shared";
import { publicClient, relayerAccount, wsClient } from "./chain";
import { config } from "./config";
import { safeMessage } from "./redact";
import {
  getCursor,
  setCursor,
  getIntentRow,
  setIntentStatus,
  insertAgentWallet,
  insertDenial,
  insertMerchant,
  insertSettlementRow,
  setMerchantProfileRow,
  type SettlementRow,
} from "./db";
import { POLICY_DENIAL_NAMES, namedErrorArgs } from "./services/pbm-core";
import { cursorOf, toSettlementEvent } from "./services/settlements";
import { broadcast } from "./sse";

/**
 * Two delivery paths, one correctness story:
 *  - watchContractEvent over WS = the <2s latency path (lossy: WS can drop);
 *  - a 15s getLogs sweep from the persisted cursor = the correctness backstop
 *    (also does startup backfill).
 * The sweep owns the cursor outright — nothing else writes it, and nothing
 * deletes a row or rewinds it at runtime. That is what lets any two hosts agree:
 * both start at `BASE_SEPOLIA_DEPLOY_BLOCK` and sweep forward, so the same range
 * yields the same rows everywhere. A clean book comes from a fresh core, not
 * from local state. SQLite PK dedup makes watch/sweep overlap harmless for
 * settlements; intent lifecycle logs only update cached status.
 */

type CoreLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
};

const blockTimeCache = new Map<bigint, number>();
async function blockTime(blockNumber: bigint): Promise<number> {
  const cached = blockTimeCache.get(blockNumber);
  if (cached !== undefined) return cached;
  const block = await publicClient.getBlock({ blockNumber });
  const time = Number(block.timestamp);
  blockTimeCache.set(blockNumber, time);
  if (blockTimeCache.size > 512) {
    blockTimeCache.delete(blockTimeCache.keys().next().value!);
  }
  return time;
}

const handleCache = new Map<string, string>();
async function resolveHandle(merchantId: Hex): Promise<string> {
  const key = merchantId.toLowerCase();
  const cached = handleCache.get(key);
  if (cached) return cached;
  // payout, categoryId, handle, displayName, location, blurb — only the handle is
  // wanted here. The display fields joined this tuple when they moved on-chain.
  const [, , handle] = (await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "merchants",
    args: [merchantId],
  })) as readonly [Address, number, string, string, string, string];
  handleCache.set(key, handle);
  return handle;
}

async function processLog(log: CoreLog): Promise<void> {
  if (log.eventName === "IntentSettled") {
    const args = log.args as {
      intentId: Hex;
      merchantId: Hex;
      payer: Address;
      tokenIn: Address;
      amountIn: bigint;
      xsgdOut: bigint;
      feeXsgd: bigint;
      door: number;
    };
    const cached = getIntentRow(args.intentId);
    const handle = cached?.handle ?? (await resolveHandle(args.merchantId));
    const row: SettlementRow = {
      tx_hash: log.transactionHash,
      log_index: log.logIndex,
      intent_id: args.intentId.toLowerCase(),
      merchant_id: args.merchantId.toLowerCase(),
      handle,
      payer: args.payer.toLowerCase(),
      token_in: args.tokenIn.toLowerCase(),
      amount_in: args.amountIn.toString(),
      xsgd_out: args.xsgdOut.toString(),
      fee_xsgd: args.feeXsgd.toString(),
      door: args.door,
      block_number: Number(log.blockNumber),
      block_time: await blockTime(log.blockNumber),
    };
    if (!insertSettlementRow(row)) return; // already seen via the other path
    setIntentStatus(args.intentId, "settled", log.transactionHash);
    broadcast("settlement", cursorOf(row), settlementEventOf(row));
    return;
  }

  if (log.eventName === "IntentCancelled") {
    const args = log.args as { intentId: Hex };
    const row = getIntentRow(args.intentId);
    if (row && row.status === "pending") setIntentStatus(args.intentId, "cancelled");
    return;
  }

  // The ONLY on-chain trace a refused agent payment leaves. The wallet's policy
  // revert dies in simulation and is never broadcast (and a reverted tx carries
  // no logs anyway), so the successful CANCEL is where the reason rides — see
  // GantryCore.cancelIntentWithReason. Sweeping it is what makes the denials
  // table chain-derived, so every host holds the same refusals instead of only
  // the one that happened to refuse the payment.
  if (log.eventName === "IntentDenied") {
    const args = log.args as { intentId?: Hex; wallet?: Address; reason?: Hex };
    // Same non-strict decode hazard as WalletCreated below: a topic0 match whose
    // data does not decode arrives with undefined fields, and a throw here would
    // leave setCursor unreached and wedge the sweep for good.
    if (!args.intentId || !args.wallet || !args.reason) {
      console.warn(`indexer: undecodable IntentDenied in ${log.transactionHash}, skipped`);
      return;
    }
    await recordDenial(args.intentId, args.wallet, args.reason, log);
    return;
  }

  /*
   * The merchant index, and every registration date with it.
   *
   * Free to sweep: the pass already reads the core's address in every window and
   * viem compiles the event list into one topic0 OR-filter, so these two cost no
   * extra RPC calls. That is what retired the separate bounded log walk in
   * services/merchants.ts — it re-covered ground this sweep had already walked,
   * capped itself at 24 windows a pass, and lost every answer on a restart.
   *
   * The registration date is the block's timestamp, so this branch pays one
   * `blockTime` read. It is cached and merchants are rare.
   */
  if (log.eventName === "MerchantRegistered") {
    const args = log.args as { merchantId?: Hex; handle?: string; categoryId?: number };
    // The permanent/transient split `recordDenial` documents at length: an
    // undecodable log can never decode, so returning past it is correct, while
    // the `blockTime` read below is transient and THROWS — leaving the cursor
    // unmoved so the next pass retries rather than losing the merchant forever.
    if (!args.merchantId || args.handle === undefined || args.categoryId === undefined) {
      console.warn(`indexer: undecodable MerchantRegistered in ${log.transactionHash}, skipped`);
      return;
    }
    insertMerchant({
      merchant_id: args.merchantId,
      handle: args.handle,
      category_id: args.categoryId,
      // The event carries `payout` too, deliberately dropped: the directory is
      // a public read surface and the table it feeds holds no such column.
      //
      // Empty text, filled by the `MerchantProfileUpdated` that follows in this
      // same transaction. That ordering is only safe because BOTH delivery paths
      // are sequential — the sweep awaits each log, and `watchChain` serializes
      // the watch. It is not safe by virtue of the log order alone: the await
      // below means this branch yields and a concurrent profile update would
      // land on a row that does not exist yet.
      display_name: "",
      location: "",
      blurb: "",
      block_number: Number(log.blockNumber),
      block_time: await blockTime(log.blockNumber),
    });
    return;
  }

  // Fires on register AND on every later edit, which is why following this one
  // event is enough to hold a merchant's CURRENT text without special-casing
  // creation. No chain read and no block time: an edit is not a date.
  if (log.eventName === "MerchantProfileUpdated") {
    const args = log.args as {
      merchantId?: Hex;
      displayName?: string;
      location?: string;
      blurb?: string;
    };
    if (
      !args.merchantId ||
      args.displayName === undefined ||
      args.location === undefined ||
      args.blurb === undefined
    ) {
      console.warn(
        `indexer: undecodable MerchantProfileUpdated in ${log.transactionHash}, skipped`,
      );
      return;
    }
    // Raw, exactly as the chain carries it. registerMerchant is permissionless
    // and the contract checks length only, so the sanitising is `resolveProfile`
    // on the read path — where it also covers rows written before a rule existed.
    setMerchantProfileRow(args.merchantId, {
      display_name: args.displayName,
      location: args.location,
      blurb: args.blurb,
    });
    return;
  }

  // From the FACTORY, not the core — the sweep now covers both addresses in one
  // pass. This replaced a separate chunked scanner in services/agents.ts that
  // re-walked the same block range on every cold process, grew ~22 windows a day,
  // and fell over on Render's shared egress IP. `getLogs` takes an address array,
  // so folding it in costs no extra RPC calls at all.
  if (log.eventName === "WalletCreated") {
    const args = log.args as { owner?: Address; agentSigner?: Address; wallet?: Address };
    // Checked, not trusted. `getLogs` with `events` decodes NON-STRICTLY, so a
    // log that matches topic0 but whose data does not decode arrives with
    // undefined fields — and `insertAgentWallet` would throw on `.toLowerCase()`,
    // escape processLog, and leave `setCursor` unreached. That wedges the cursor
    // for good: every later pass retries the same log and no settlement past that
    // block is ever indexed. One bad log must not be able to stop the feed.
    if (!args.wallet || !args.owner || !args.agentSigner) {
      console.warn(`indexer: undecodable WalletCreated in ${log.transactionHash}, skipped`);
      return;
    }
    insertAgentWallet({
      wallet: args.wallet,
      owner: args.owner,
      agent_signer: args.agentSigner,
      block_number: Number(log.blockNumber),
      factory: config.addresses.agentPbmFactory,
    });
  }
}

/** The denials table stores args as JSON text or null — never "undefined". */
function jsonArgs(args: Record<string, unknown> | undefined): string | null {
  return args ? JSON.stringify(args) : null;
}

/**
 * Rebuild a denial row from the chain alone.
 *
 * Everything a row needs is either on the event or still readable off the
 * cancelled intent: cancellation does not delete it, so `getIntent` still holds
 * the merchant, the token and both amounts. That is why the event carries only
 * what cannot be recovered — the wallet that refused, and why.
 *
 * PERMANENT defects return; TRANSIENT ones THROW, and the split is the whole
 * design of this function. A throw escaping `processLog` leaves `setCursor`
 * unreached, so the next 15s pass retries the same log — which is exactly what
 * the `IntentSettled` branch above already relies on, since it calls the same
 * `resolveHandle` and `blockTime` with no catch of its own. Swallowing an RPC
 * blip here instead would advance the cursor past a refusal and lose it forever,
 * with `lastSweepError` still null and /health still reporting lag 0: the payer's
 * screen would show no declined row, indistinguishable from a refusal that never
 * happened, on the one screen that exists to show them.
 */
async function recordDenial(intentId: Hex, wallet: Address, reason: Hex, log: CoreLog): Promise<void> {
  // --- permanent: retrying can never help, so advancing past it is correct.
  const decoded = decodeRawError(reason);
  if (!decoded || decoded.kind !== "custom") {
    console.warn(`indexer: IntentDenied ${intentId} carries an undecodable reason ${reason}`);
    return;
  }
  // Re-checked here and not merely trusted from the writer. `decodeRawError`
  // resolves against the WHOLE union — core, swap, wallet, EIP-3009 — so a
  // core-level revert like IntentExpired would decode happily and render on the
  // payer's receipt under "Your agent tried, the contract said no", with args
  // named against the wallet ABI it does not belong to. A stale quote is not the
  // agent being refused, and this table is the only thing that says which it was.
  if (!POLICY_DENIAL_NAMES.has(decoded.name)) {
    console.warn(
      `indexer: IntentDenied ${intentId} names ${decoded.name}, which is not a wallet ` +
        "policy error — refusing to render it as a refusal",
    );
    return;
  }

  // --- transient from here down: every line is an RPC or a disk write.
  const intent = await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "getIntent",
    args: [intentId],
  });
  // getIntent returns the ZERO STRUCT for an unknown id rather than reverting —
  // the contract's own natspec says callers must check. This read is unpinned and
  // lands milliseconds after a WS log through a fallback transport, so a replica
  // that has not seen the block answers "None". Writing that would store a denial
  // at a nameless merchant for S$0.00, and `INSERT OR REPLACE` would let it
  // overwrite a correct row the other delivery path had already written.
  if (intent.status === IntentStatus.None) {
    throw new Error(
      `indexer: getIntent(${intentId}) is empty at a block that denied it — replica lag, retrying`,
    );
  }
  const handle = await resolveHandle(intent.merchantId);
  const createdAt = await blockTime(log.blockNumber);
  insertDenial({
    intent_id: intentId,
    handle,
    merchant_id: intent.merchantId,
    wallet,
    token_in: intent.tokenIn,
    amount_in: intent.amountIn.toString(),
    xsgd_amount: intent.xsgdAmount.toString(),
    error_name: decoded.name,
    // Reuses the wallet-ABI naming the backend already applies, so a denial
    // swept from the chain and one recorded live render identically.
    error_args: jsonArgs(namedErrorArgs(decoded.name, decoded.args)),
    // The cancel IS this transaction — the one the payer's receipt links to.
    cancel_tx: log.transactionHash,
    created_at: createdAt,
  });
}

/**
 * The row→wire mapping every settlement surface shares, bound to the configured
 * address table. Only the binding lives here: the mapping itself is
 * `toSettlementEvent` in services/settlements.ts, config-free so it can be
 * pinned directly rather than through a stand-in that drifts from it.
 */
export function settlementEventOf(row: SettlementRow): SettlementEvent {
  return toSettlementEvent(
    row,
    (token: Address) => tokenIdByAddress(config.addresses, token),
    relayerAccount.address,
  );
}

// Sized to the public sepolia.base.org node's 2,000-block getLogs ceiling — see
// LOG_CHUNK_SPAN for the measured provider facts, including why the paid primary
// serves none of these calls. This is now the constant's ONLY consumer: the
// factory scan in services/agents.ts and the registration-date walk in
// services/merchants.ts were both folded into this sweep and deleted.
const SWEEP_CHUNK = LOG_CHUNK_SPAN;

/**
 * Exactly the events the sweep acts on, from both contracts.
 *
 * Narrowed rather than passing whole ABIs: `getLogs` turns this into one topic0
 * OR-filter, so anything not listed here is never transferred, decoded, or
 * handed to `processLog` for it to ignore. Adding an event to a contract does
 * not silently start costing bandwidth — it has to be named here first.
 */
const SWEPT_EVENTS = [
  ...gantryCoreAbi.filter(
    (entry): entry is Extract<(typeof gantryCoreAbi)[number], { type: "event" }> =>
      entry.type === "event" &&
      (entry.name === "IntentSettled" ||
        entry.name === "IntentCancelled" ||
        entry.name === "IntentDenied" ||
        entry.name === "MerchantRegistered" ||
        entry.name === "MerchantProfileUpdated"),
  ),
  ...agentPbmWalletFactoryAbi.filter(
    (entry): entry is Extract<(typeof agentPbmWalletFactoryAbi)[number], { type: "event" }> =>
      entry.type === "event" && entry.name === "WalletCreated",
  ),
] as const;

/**
 * These six by NAME, always. `pnpm abis` regenerates these ABIs from the
 * contracts, so a renamed or removed event silently yields a shorter array — the
 * sweep would stop indexing it while the cursor kept advancing, which is
 * unrecoverable without a manual rewind. The live settlement feed is the one
 * thing CLAUDE.md says is never cut, so it fails at boot instead. Same shape as
 * the accepts[0] assertion in routes/order.ts.
 *
 * The set, not the count: a rename paired with any addition keeps the length at
 * six and would sail through a length check, which is exactly the silent
 * outcome this exists to prevent.
 */
const EXPECTED_SWEPT_EVENTS = [
  "IntentCancelled",
  "IntentDenied",
  "IntentSettled",
  "MerchantProfileUpdated",
  "MerchantRegistered",
  "WalletCreated",
].join(", ");

{
  const found = SWEPT_EVENTS.map((entry) => entry.name)
    .sort()
    .join(", ");
  if (found !== EXPECTED_SWEPT_EVENTS) {
    throw new Error(
      `indexer: expected to sweep [${EXPECTED_SWEPT_EVENTS}], found [${found}] — ` +
        "an event was renamed or removed in the contracts and the sweep would " +
        "silently stop indexing it while the cursor kept advancing",
    );
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Why the last sweep failed, or null if it succeeded.
 *
 * The sweep swallows its own errors so a bad minute cannot kill the process —
 * but a caller that needs to say "this payer owns no wallets" has to know the
 * difference between an index that is current and one that never ran. Answering
 * an empty list on a failed sweep is the outcome that makes an agent CLI mint a
 * DUPLICATE wallet, which is what the deleted scanner's `AgentScanFailed` 503
 * existed to prevent.
 */
let lastSweepError: string | null = null;

/** Bound on how long an HTTP request will wait for an on-demand sweep. A cold
 * process has no cursor, so the pass it joins can be a full backfill — ~89
 * getLogs windows on the rate-limited public node. The deleted scanner carried
 * the same 15s deadline, tuned under the web client's 20s abort. Past this the
 * sweep keeps running; only the waiting stops. */
const ON_DEMAND_SWEEP_MS = 12_000;

function runSweep(): Promise<void> {
  inFlight ??= sweep().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Bring the index up to date and report whether it actually is.
 *
 * Joining an in-flight pass is NOT enough, and the previous version of this
 * claimed otherwise: that pass read its head before this call, so it can say
 * nothing about a block mined since — precisely the case that matters, an agent
 * asking about a wallet it created a second ago. So it waits the running pass
 * out and then starts a fresh one whose head read happens after the caller
 * arrived.
 *
 * Returns false when the sweep failed OR the wait ran out, because both mean the
 * same thing to a caller: the index cannot be trusted to be current, so "nothing
 * found" is not an answer.
 */
export async function sweepNow(): Promise<boolean> {
  const running = inFlight;
  if (running) await running;
  let timedOut = false;
  await Promise.race([
    runSweep(),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, ON_DEMAND_SWEEP_MS).unref(),
    ),
  ]);
  return !timedOut && lastSweepError === null;
}

/**
 * Last head the sweep managed to read, and when. Recorded here so /health can
 * answer "is the chain reachable, and is the indexer keeping up" without making
 * an RPC call of its own — the health route is polled by the deploy host, and a
 * probe that depends on a third party turns a provider's bad minute into a
 * restart. The sweep already fetches head every 15s; this just remembers it.
 *
 * Set as soon as the head read succeeds rather than after a full pass, which
 * splits one vague "healthy" into two independent signals: a stale `headAt`
 * means the RPC path is down, while a growing `head - cursor` means the reads
 * work but the getLogs chunks do not.
 */
let lastHead: bigint | null = null;
let lastHeadAt: number | null = null;

export interface IndexerStatus {
  /** Persisted sweep cursor — the last block whose logs are definitely in. */
  cursor: number;
  /** Chain head as of the last successful read, or null before the first one. */
  head: number | null;
  /** Blocks behind. Null until a head is known; never negative. */
  lag: number | null;
  /** Unix seconds of that read. Stale ⇒ the RPC path is failing. */
  headAt: number | null;
}

export function indexerStatus(): IndexerStatus {
  const cursor = Number(getCursor() ?? config.deployBlock);
  const head = lastHead === null ? null : Number(lastHead);
  return {
    cursor,
    head,
    lag: head === null ? null : Math.max(0, head - cursor),
    headAt: lastHeadAt,
  };
}

async function sweep(): Promise<void> {
  try {
    const head = await publicClient.getBlockNumber();
    lastHead = head;
    lastHeadAt = Math.floor(Date.now() / 1000);
    let from = (getCursor() ?? config.deployBlock - 1n) + 1n;
    while (from <= head) {
      const to = from + SWEEP_CHUNK > head ? head : from + SWEEP_CHUNK;
      // Both contracts, one window. They share a deploy block now, so there is no
      // range where only one of them can have logs — which is the whole reason the
      // single `BASE_SEPOLIA_DEPLOY_BLOCK` was worth a redeploy. viem builds an OR
      // topic filter across the two ABIs; the signatures do not collide, so a core
      // log can never decode as a factory one.
      const logs = await publicClient.getLogs({
        address: [config.addresses.gantryCore, config.addresses.agentPbmFactory],
        events: SWEPT_EVENTS,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        await processLog(log as unknown as CoreLog);
      }
      setCursor(to);
      from = to + 1n;
    }
    lastSweepError = null;
  } catch (err) {
    lastSweepError = safeMessage(err);
    console.error("indexer sweep failed:", lastSweepError);
  }
}

let watchBackoffMs = 1_000;

/**
 * Serializes the watch path, and it is load-bearing rather than tidy.
 *
 * `processLog` awaits an RPC in some branches and not others, so dispatching
 * logs concurrently reorders them by how much I/O each one happens to do — not
 * by the order the chain produced them. `registerMerchant` emits
 * `MerchantRegistered` then `MerchantProfileUpdated` in ONE transaction, and the
 * first awaits `blockTime` while the second is pure SQLite: fired concurrently,
 * the profile UPDATE always ran first, matched zero rows, and the merchant was
 * then inserted with empty display text. Not a race — deterministic, because an
 * `await` always yields and the loop's next iteration runs in the same turn.
 *
 * The 15s sweep repaired it (it awaits each log in `getLogs` order), so the
 * symptom was a freshly onboarded shop rendering as its bare handle for up to
 * one sweep — on the surface that had just told it registration succeeded.
 *
 * Chaining costs nothing here: logs are rare, and the sweep is the throughput
 * path anyway. Each link catches its own failure so one bad log cannot break the
 * chain for every log after it.
 */
let watchChain: Promise<void> = Promise.resolve();

function startWatch(): void {
  const unwatch = wsClient.watchContractEvent({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    onLogs: (logs) => {
      watchBackoffMs = 1_000;
      for (const log of logs) {
        watchChain = watchChain
          .then(() => processLog(log as unknown as CoreLog))
          .catch((err) => console.error("indexer watch processing failed:", err));
      }
    },
    onError: (err) => {
      console.error("indexer watch error, resubscribing:", err.message);
      try {
        unwatch();
      } catch {
        /* already torn down */
      }
      const delay = watchBackoffMs;
      watchBackoffMs = Math.min(watchBackoffMs * 2, 30_000);
      setTimeout(startWatch, delay).unref();
    },
  });
}

export async function startIndexer(): Promise<void> {
  await runSweep(); // startup backfill from persisted cursor
  startWatch();
  // `runSweep`, not `sweepNow`: the timer wants the coalescing (skip if a pass is
  // already running) and has no interest in a fresh head read.
  setInterval(() => void runSweep(), 15_000).unref();
  console.log(`indexer running (cursor ${getCursor() ?? config.deployBlock})`);
}

/*
 * There is deliberately no `resetIndexer` here any more, and no route that
 * calls one.
 *
 * Every version of it made the local cache disagree with the chain it is
 * supposed to mirror — first by deleting rows and jumping the cursor past them,
 * then by hiding rows behind a display floor. Either way the demo laptop showed
 * a different book from the deployed host, which is the disparity the single
 * deploy block exists to remove. A per-host emptiness knob cannot coexist with
 * "both hosts index the same chain from the same block and agree".
 *
 * A clean book is a fresh core: `pnpm contracts:fresh` deploys all four
 * contracts together, pins one new `BASE_SEPOLIA_DEPLOY_BLOCK`, and drops the
 * local database. Every host then backfills from that block and they start
 * equal — and stay equal, because nothing ever diverges them again.
 */
