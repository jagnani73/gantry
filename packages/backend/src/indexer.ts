import type { Address, Hex } from "viem";
import {
  LOG_CHUNK_SPAN,
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
  insertSettlementRow,
  clearCache,
  type SettlementRow,
} from "./db";
import { cursorOf, toSettlementEvent } from "./services/settlements";
import { broadcast } from "./sse";

/**
 * Two delivery paths, one correctness story:
 *  - watchContractEvent over WS = the <2s latency path (lossy: WS can drop);
 *  - a 15s getLogs sweep from the persisted cursor = the correctness backstop
 *    (also does startup backfill).
 * The sweep owns the cursor; admin reset (resetIndexer) jumps it to head under
 * a new epoch, aborting any in-flight sweep before it can re-insert cleared
 * rows or rewind the cursor. SQLite PK dedup makes watch/sweep overlap
 * harmless for settlements; intent lifecycle logs only update cached status.
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
  const [, , handle] = (await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "merchants",
    args: [merchantId],
  })) as readonly [Address, number, string];
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

let sweeping = false;
let resetEpoch = 0;

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
  if (sweeping) return;
  sweeping = true;
  const epoch = resetEpoch;
  try {
    const head = await publicClient.getBlockNumber();
    lastHead = head;
    lastHeadAt = Math.floor(Date.now() / 1000);
    let from = (getCursor() ?? config.deployBlock - 1n) + 1n;
    while (from <= head) {
      const to = from + SWEEP_CHUNK > head ? head : from + SWEEP_CHUNK;
      const logs = await publicClient.getContractEvents({
        address: config.addresses.gantryCore,
        abi: gantryCoreAbi,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        if (epoch !== resetEpoch) return; // reset landed mid-sweep — abandon
        await processLog(log as unknown as CoreLog);
      }
      if (epoch !== resetEpoch) return;
      setCursor(to);
      from = to + 1n;
    }
  } catch (err) {
    console.error("indexer sweep failed:", err instanceof Error ? err.message : err);
  } finally {
    sweeping = false;
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
  await sweep(); // startup backfill from persisted cursor
  startWatch();
  setInterval(() => void sweep(), 15_000).unref();
  console.log(`indexer running (cursor ${getCursor() ?? config.deployBlock})`);
}

/**
 * Admin reset: clear the cache and jump the cursor to the current head under a
 * new epoch. Head is fetched first so a failed RPC call leaves the cache
 * intact instead of cleared-but-rewound.
 */
export async function resetIndexer(): Promise<void> {
  const head = await publicClient.getBlockNumber();
  resetEpoch++;
  clearCache();
  setCursor(head);
  // Same read the sweep records, so a reset does not leave /health reporting a
  // lag against a head from before the cursor jumped.
  lastHead = head;
  lastHeadAt = Math.floor(Date.now() / 1000);
}
