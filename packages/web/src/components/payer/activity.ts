import type { Address } from "viem";
import type { DenialEvent, SettlementEvent } from "@gantry/shared";

/**
 * One feed out of two sources.
 *
 * A settled payment is an on-chain event the indexer saw; a refused one never
 * reached the chain at all — the wallet's policy revert is caught in simulation
 * and nothing is broadcast — so it is a server-side record with no block, no
 * log index and no settlement tx. They sit in the same list because that is the
 * payer's mental model ("what did my money and my agents do today"), and the
 * only place the difference must survive is arithmetic: a declined attempt
 * moved nothing, so it is never in a total.
 */

export type ActivityFilter = "all" | "me" | "agents";

export type ActivityRow =
  | {
      kind: "settlement";
      /** `${txHash}:${logIndex}` — the backend's own primary key for the row. */
      key: string;
      at: number;
      handle: string;
      settlement: SettlementEvent;
    }
  | {
      kind: "denial";
      key: string;
      at: number;
      handle: string;
      denial: DenialEvent;
    };

export function settlementKey(row: SettlementEvent): string {
  return `${row.txHash}:${row.logIndex}`;
}

export function denialKey(row: DenialEvent): string {
  return `denial:${row.intentId}`;
}

/**
 * The row a `?receipt=<key>` URL names, or null.
 *
 * The exact key is the whole answer for every row that came from the index. The
 * fallback exists for exactly ONE producer: the pay flow builds a receipt
 * locally the instant a payment settles — before the indexer has seen it — and
 * it cannot know the log index, so it writes 0. The key that reaches the URL
 * after a payment is therefore `<txHash>:0` while the indexed row arriving
 * seconds later is `<txHash>:9`. Without this, refreshing the receipt you are
 * looking at reports the payment as not in your history, permanently, for a
 * payment sitting one tab away in Activity.
 *
 * It resolves only when EXACTLY ONE loaded row shares the transaction. Two
 * settlements in one transaction is a shape the relayer never produces — it
 * settles one intent per transaction — but if one ever appeared, picking
 * between them would be a guess, and a receipt is the wrong screen to guess on.
 * It declines instead, and "not in this wallet's history" stands.
 */
export function findActivityRow(
  rows: readonly ActivityRow[],
  key: string,
): ActivityRow | null {
  const exact = rows.find((row) => row.key === key);
  if (exact) return exact;
  const txHash = settlementKeyTx(key);
  if (txHash === null) return null;
  const sameTx = rows.filter(
    (row) => row.kind === "settlement" && row.settlement.txHash.toLowerCase() === txHash,
  );
  return sameTx.length === 1 ? sameTx[0]! : null;
}

/** The transaction half of a `settlementKey`, or null for anything that is not
 * one — a denial key names no transaction, and a refusal never reached the
 * chain, so there is nothing for the fallback above to match it on. */
function settlementKeyTx(key: string): string | null {
  const split = key.lastIndexOf(":");
  if (split <= 0) return null;
  const txHash = key.slice(0, split).toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(txHash) && /^\d+$/.test(key.slice(split + 1)) ? txHash : null;
}

/**
 * Newest first. Settlements in the same block fall back to (blockNumber,
 * logIndex) so the client's order is the server's order — two rows that arrive
 * with one `blockTime` must not swap places between a page load and a refresh.
 * A denial is timestamped by the server's clock and has no block to compare, so
 * when it ties with a settlement it sorts first: it is the attempt, and the
 * retry that followed it is the settlement.
 */
export function toActivityRows(
  settlements: readonly SettlementEvent[],
  denials: readonly DenialEvent[],
): ActivityRow[] {
  const rows: ActivityRow[] = [
    ...settlements.map(
      (settlement): ActivityRow => ({
        kind: "settlement",
        key: settlementKey(settlement),
        at: settlement.blockTime,
        handle: settlement.handle,
        settlement,
      }),
    ),
    ...denials.map(
      (denial): ActivityRow => ({
        kind: "denial",
        key: denialKey(denial),
        at: denial.at,
        handle: denial.handle,
        denial,
      }),
    ),
  ];

  rows.sort((a, b) => {
    if (b.at !== a.at) return b.at - a.at;
    if (a.kind === "settlement" && b.kind === "settlement") {
      return (
        b.settlement.blockNumber - a.settlement.blockNumber ||
        b.settlement.logIndex - a.settlement.logIndex
      );
    }
    if (a.kind === b.kind) return 0;
    return a.kind === "denial" ? -1 : 1;
  });

  return rows;
}

/**
 * "I paid this myself", which is narrower than "my address is on it".
 *
 * A PBM payment's on-chain payer is the agent's wallet and a bridged x402
 * payment's is the relayer — both are agent spending and belong under "My
 * agents" even though the human owns the wallet that moved. Only a row whose
 * payer IS the human, with no facilitator behind it, is a payment the human
 * made.
 */
export function isOwnPayment(row: ActivityRow, payer: Address | null): boolean {
  if (row.kind !== "settlement" || !payer) return false;
  if (row.settlement.bridged) return false;
  return row.settlement.payer.toLowerCase() === payer.toLowerCase();
}

export function filterActivity(
  rows: readonly ActivityRow[],
  payer: Address | null,
  filter: ActivityFilter,
): ActivityRow[] {
  if (filter === "all") return [...rows];
  const mine = filter === "me";
  return rows.filter((row) => isOwnPayment(row, payer) === mine);
}

/**
 * What the payer spent, in XSGD 6dp units.
 *
 * Uses `xsgdOut` (gross) rather than the merchant's net, because this is the
 * payer's side of the ledger: they paid S$4.50; the 0.5% the protocol skimmed is
 * the shop's cost, not theirs. Declined attempts contribute nothing — no
 * transfer happened — which is why the filter is on `kind` and not on a flag
 * somebody could forget to set.
 */
export function activityTotal(rows: readonly ActivityRow[]): bigint {
  return rows.reduce(
    (sum, row) => (row.kind === "settlement" ? sum + BigInt(row.settlement.xsgdOut) : sum),
    0n,
  );
}

export interface PlacePaid {
  handle: string;
  payments: number;
  total: bigint;
  /** Unix seconds of the oldest settlement here — the "first visit" line. */
  firstAt: number;
}

/**
 * "Places you've paid", derived entirely from the payer's own settlement
 * history. There is no merchant directory to browse — a payer reaches a shop
 * from a receipt or from having paid it — so this list is the only index that
 * exists, and it cannot show a shop they have never been to.
 */
export function placesPaid(rows: readonly ActivityRow[]): PlacePaid[] {
  const byHandle = new Map<string, PlacePaid>();
  for (const row of rows) {
    if (row.kind !== "settlement") continue;
    const existing = byHandle.get(row.handle);
    if (existing) {
      existing.payments += 1;
      existing.total += BigInt(row.settlement.xsgdOut);
      existing.firstAt = Math.min(existing.firstAt, row.at);
    } else {
      byHandle.set(row.handle, {
        handle: row.handle,
        payments: 1,
        total: BigInt(row.settlement.xsgdOut),
        firstAt: row.at,
      });
    }
  }
  return [...byHandle.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
}
