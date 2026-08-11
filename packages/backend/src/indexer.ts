import type { Address, Hex } from "viem";
import {
  LOG_CHUNK_SPAN,
  agentPbmWalletFactoryAbi,
  gantryCoreAbi,
  tokenIdByAddress,
  type SettlementEvent,
} from "@gantry/shared";
import { publicClient, wsClient } from "./chain";
import { config } from "./config";
import {
  getCursor,
  setCursor,
  getIntentRow,
  setIntentStatus,
  insertAgentWallet,
  insertSettlementRow,
  setDisplayFloor,
  type SettlementRow,
} from "./db";
import { cursorOf, toSettlementEvent } from "./services/settlements";
import { broadcast } from "./sse";

/**
 * Two delivery paths, one correctness story:
 *  - watchContractEvent over WS = the <2s latency path (lossy: WS can drop);
 *  - a 15s getLogs sweep from the persisted cursor = the correctness backstop
 *    (also does startup backfill).
 * The sweep owns the cursor outright — nothing else writes it. Admin reset
 * (resetIndexer) no longer touches it or deletes anything; it records a display
 * floor and lets the sweep carry on, so an in-flight pass is never a hazard and
 * needs no epoch to abort it. SQLite PK dedup makes watch/sweep overlap harmless
 * for settlements; intent lifecycle logs only update cached status.
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
      agent_payer: cached?.agent_payer ?? null,
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

/**
 * The row→wire mapping every settlement surface shares, bound to the configured
 * address table. Only the binding lives here: the mapping itself is
 * `toSettlementEvent` in services/settlements.ts, config-free so it can be
 * pinned directly rather than through a stand-in that drifts from it.
 */
export function settlementEventOf(row: SettlementRow): SettlementEvent {
  return toSettlementEvent(row, (token: Address) => tokenIdByAddress(config.addresses, token));
}

// Sized to the public sepolia.base.org node's 2,000-block getLogs ceiling, and
// shared with the other two chunked walks — see LOG_CHUNK_SPAN for the measured
// provider facts (including why the paid primary serves none of these calls).
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
      entry.type === "event" && (entry.name === "IntentSettled" || entry.name === "IntentCancelled"),
  ),
  ...agentPbmWalletFactoryAbi.filter(
    (entry): entry is Extract<(typeof agentPbmWalletFactoryAbi)[number], { type: "event" }> =>
      entry.type === "event" && entry.name === "WalletCreated",
  ),
] as const;

/**
 * Three, always. `pnpm abis` regenerates these ABIs from the contracts, so a
 * renamed or removed event silently yields a shorter array — the sweep would
 * stop indexing it while the cursor kept advancing, which is unrecoverable
 * without a manual rewind. The live settlement feed is the one thing CLAUDE.md
 * says is never cut, so it fails at boot instead. Same shape as the accepts[0]
 * assertion in routes/order.ts.
 */
if (SWEPT_EVENTS.length !== 3) {
  throw new Error(
    `indexer: expected 3 swept events (IntentSettled, IntentCancelled, WalletCreated), got ${SWEPT_EVENTS.length}`,
  );
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
    lastSweepError = err instanceof Error ? err.message : String(err);
    console.error("indexer sweep failed:", lastSweepError);
  }
}

let watchBackoffMs = 1_000;
function startWatch(): void {
  const unwatch = wsClient.watchContractEvent({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    onLogs: (logs) => {
      watchBackoffMs = 1_000;
      for (const log of logs) {
        void processLog(log as unknown as CoreLog).catch((err) =>
          console.error("indexer watch processing failed:", err),
        );
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

/**
 * Admin reset: start the rehearsal feed from here.
 *
 * This deletes nothing and does not move the cursor. It records a display floor
 * at the current head, and the read surfaces skip what lies beneath it — so the
 * cache remains a faithful projection of the chain, and this box and a deployed
 * host converge on identical rows from the identical floor. See `DisplayFloor`
 * in db-core for why emptiness is a rendering fact rather than a storage one.
 *
 * The head read comes first so a failing RPC leaves the previous floor in place
 * rather than writing one built from a fallback — a floor is what the whole feed
 * is measured against, and a wrong one is silent.
 */
export async function resetIndexer(): Promise<void> {
  const head = await publicClient.getBlockNumber();
  const at = Math.floor(Date.now() / 1000);
  // Exclusive on block, inclusive on time — see DisplayFloor. `head` is the last
  // block that can hold a pre-reset settlement, and a denial written from here on
  // carries a `created_at` at or after this second.
  setDisplayFloor({ block: Number(head), at });
  // Same read the sweep records, so a reset does not leave /health reporting a
  // lag against a head from before this call.
  lastHead = head;
  lastHeadAt = at;
}
