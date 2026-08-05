import type { Address, Hex } from "viem";
import {
  Door,
  doorToWire,
  gantryCoreAbi,
  tokenIdByAddress,
  type SettlementEvent,
  type IntentLifecycleEvent,
} from "@gantry/shared";
import { publicClient, wsClient } from "./chain";
import { config } from "./config";
import {
  getCursor,
  setCursor,
  getIntentRow,
  setIntentStatus,
  insertSettlementRow,
  type SettlementRow,
} from "./db";
import { broadcast } from "./sse";

/**
 * Two delivery paths, one correctness story:
 *  - watchContractEvent over WS = the <2s latency path (lossy: WS can drop);
 *  - a 15s getLogs sweep from the persisted cursor = the correctness backstop
 *    (also does startup backfill). Only the sweep advances the cursor.
 * SQLite PK dedup makes overlap harmless.
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
    const handle =
      getIntentRow(args.intentId)?.handle ?? (await resolveHandle(args.merchantId));
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
    broadcast("settlement", `${row.block_number}:${row.log_index}`, settlementEventOf(row));
    return;
  }

  if (log.eventName === "IntentCancelled") {
    const args = log.args as { intentId: Hex };
    const row = getIntentRow(args.intentId);
    if (row && row.status === "pending") setIntentStatus(args.intentId, "cancelled");
    const payload: IntentLifecycleEvent = {
      type: "cancelled",
      intentId: args.intentId,
      merchantId: (row?.merchant_id ?? "0x") as Hex,
      handle: row?.handle ?? null,
      xsgdAmount: row?.xsgd_amount ?? "0",
      door: doorToWire((row?.door ?? Door.Human) as Door),
    };
    broadcast("intent", null, payload);
    return;
  }

  if (log.eventName === "IntentCreated") {
    const args = log.args as { intentId: Hex; merchantId: Hex; xsgdAmount: bigint; door: number };
    const payload: IntentLifecycleEvent = {
      type: "created",
      intentId: args.intentId,
      merchantId: args.merchantId,
      handle: getIntentRow(args.intentId)?.handle ?? null,
      xsgdAmount: args.xsgdAmount.toString(),
      door: doorToWire(args.door as Door),
    };
    broadcast("intent", null, payload);
  }
}

export function settlementEventOf(row: SettlementRow): SettlementEvent {
  return {
    intentId: row.intent_id as Hex,
    merchantId: row.merchant_id as Hex,
    handle: row.handle,
    payer: row.payer as Address,
    tokenIn: row.token_in as Address,
    tokenSymbol: tokenIdByAddress(config.addresses, row.token_in as Address),
    amountIn: row.amount_in,
    xsgdOut: row.xsgd_out,
    feeXsgd: row.fee_xsgd,
    door: doorToWire(row.door as Door),
    txHash: row.tx_hash as Hex,
    blockNumber: row.block_number,
    blockTime: row.block_time,
  };
}

const SWEEP_CHUNK = 9_000n; // Alchemy free tier caps getLogs ranges at 10k blocks

let sweeping = false;
async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const head = await publicClient.getBlockNumber();
    let from = (getCursor() ?? config.deployBlock - 1n) + 1n;
    while (from <= head) {
      const to = from + SWEEP_CHUNK > head ? head : from + SWEEP_CHUNK;
      const logs = await publicClient.getContractEvents({
        address: config.addresses.gantryCore,
        abi: gantryCoreAbi,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) await processLog(log as unknown as CoreLog);
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

/** Admin reset support: jump the cursor to the current head. */
export async function resetCursorToHead(): Promise<void> {
  setCursor(await publicClient.getBlockNumber());
}
