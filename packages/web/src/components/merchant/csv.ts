import { formatUnits6, type SettlementEvent } from "@gantry/shared";
import { clockTime, netOf, shortDate } from "./format";

/**
 * The transactions table, as a file a merchant can hand to whoever does their
 * books.
 *
 * Amounts are written at FULL 6dp precision, not at the two places the screen
 * shows. The screen is rounding for a human reading a column; an export is a
 * record that has to reconcile against the chain, and a rounded fee column would
 * not add up to the gross for anyone who checked.
 *
 * Every identifier is written in full for the same reason — a truncated
 * `0x9f2c…4ae1` cannot be looked up, which is the only thing an exported hash is
 * for.
 */

const HEADER = [
  "date",
  "time",
  "door",
  "payer",
  "settled_by_facilitator",
  "token",
  "amount_in",
  "gross_xsgd",
  "fee_xsgd",
  "net_xsgd",
  "tx_hash",
  "block_number",
  "log_index",
  "intent_id",
] as const;

/** RFC 4180: quote when the value could otherwise break the row, and double any
 * quote inside it. Nothing here can currently contain a comma, but a shop that
 * renames itself into one should not silently shift every column. */
function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function settlementsCsv(rows: readonly SettlementEvent[]): string {
  const lines = [HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        shortDate(row.blockTime),
        clockTime(row.blockTime),
        row.door,
        row.payer,
        row.bridged ? "yes" : "no",
        row.tokenSymbol ?? "",
        formatUnits6(BigInt(row.amountIn), 6),
        formatUnits6(BigInt(row.xsgdOut), 6),
        formatUnits6(BigInt(row.feeXsgd), 6),
        formatUnits6(netOf(row), 6),
        row.txHash,
        String(row.blockNumber),
        String(row.logIndex),
        row.intentId,
      ]
        .map(cell)
        .join(","),
    );
  }
  // Trailing newline: a file without one appends to the previous line when it is
  // concatenated with another export.
  return `${lines.join("\r\n")}\r\n`;
}

/** U+FEFF as an escape, never as a literal — an invisible character in source is
 * one nobody can review, diff or safely edit. */
const BOM = String.fromCharCode(0xfeff);

export function downloadCsv(filename: string, csv: string): void {
  // The BOM is what makes Excel read the file as UTF-8 rather than as the
  // system codepage, which is where a shop name with an accent in it goes wrong.
  const blob = new Blob([BOM, csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
