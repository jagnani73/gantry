"use client";

import { BASESCAN_BASE_URL, formatUnits6, type SettlementEvent } from "@gantry/shared";
import { Badge } from "@/components/ui/badge";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function SettlementRow({ row }: { row: SettlementEvent & { live: boolean } }) {
  const time = new Date(row.blockTime * 1000).toLocaleTimeString("en-SG", { hour12: false });
  const net = BigInt(row.xsgdOut) - BigInt(row.feeXsgd);
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border p-3 ${row.live ? "animate-[pulse_1.2s_ease-in-out_1] border-primary/60" : ""}`}
    >
      <Badge variant={row.door === "agent" ? "default" : "secondary"}>
        {row.door === "agent" ? "🤖 Agent" : "🧑 Human"}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="font-semibold tabular-nums">
          S${formatUnits6(BigInt(row.xsgdOut))}{" "}
          <span className="text-xs font-normal text-muted-foreground">
            net {formatUnits6(net)} XSGD · fee {formatUnits6(BigInt(row.feeXsgd), 4)}
          </span>
        </p>
        <p className="truncate text-xs text-muted-foreground" title={`on-chain payer ${row.payer}`}>
          {formatUnits6(BigInt(row.amountIn), 6)} {row.tokenSymbol === "MUSDC" ? "USDC" : (row.tokenSymbol ?? "?")} from{" "}
          {shortAddress(row.agentPayer ?? row.payer)}
          {row.agentPayer ? " · via facilitator" : ""}
        </p>
      </div>
      <div className="text-right text-xs text-muted-foreground">
        <p className="tabular-nums">{time}</p>
        <a
          className="text-primary underline-offset-2 hover:underline"
          href={`${BASESCAN_BASE_URL}/tx/${row.txHash}`}
          target="_blank"
          rel="noreferrer"
        >
          tx ↗
        </a>
      </div>
    </li>
  );
}
