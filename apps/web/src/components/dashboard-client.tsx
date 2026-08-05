"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CARD_FEE_BPS,
  DEMO_MERCHANTS,
  GANTRY_FEE_BPS,
  formatUnits6,
  type SettlementEvent,
} from "@gantry/shared";
import { backendUrl } from "@/lib/env";
import { chime, enableSound, soundEnabled } from "@/lib/chime";
import { SettlementRow } from "@/components/settlement-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type FeedRow = SettlementEvent & { eventId: string; live: boolean };

export function DashboardClient() {
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [dead, setDead] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const seen = useRef(new Set<string>());
  const connectedAt = useRef(0);

  useEffect(() => {
    const source = new EventSource(`${backendUrl()}/api/events`);
    connectedAt.current = Date.now();

    source.onopen = () => {
      connectedAt.current = Date.now();
      setConnected(true);
    };
    source.onerror = () => {
      setConnected(false);
      // Browsers auto-retry network drops but permanently close on non-200/CORS
      // failures — "reconnecting…" would then be a lie that eats setup time.
      if (source.readyState === EventSource.CLOSED) setDead(true);
    };

    source.addEventListener("settlement", (event) => {
      const data = JSON.parse(event.data) as SettlementEvent;
      const eventId = event.lastEventId || `${data.blockNumber}:${data.txHash}`;
      if (seen.current.has(eventId)) return;
      seen.current.add(eventId);
      const live = Date.now() - connectedAt.current > 2000;
      setRows((prev) => [{ ...data, eventId, live }, ...prev]);
      if (live) chime();
    });

    source.addEventListener("reset", () => {
      seen.current.clear();
      setRows([]);
    });

    return () => source.close();
  }, []);

  const summary = useMemo(() => {
    const gross = rows.reduce((sum, row) => sum + BigInt(row.xsgdOut), 0n);
    const fees = rows.reduce((sum, row) => sum + BigInt(row.feeXsgd), 0n);
    const cardFees = (gross * BigInt(CARD_FEE_BPS)) / 10_000n;
    return { count: rows.length, net: gross - fees, saved: cardFees - fees };
  }, [rows]);

  const merchantName = DEMO_MERCHANTS["ah-hock-chicken-rice"]?.displayName ?? "Merchant";

  return (
    <div className="dark min-h-dvh bg-background text-foreground">
      <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-4 p-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{merchantName}</h1>
            <p className="text-sm text-muted-foreground">
              Live settlements · Base Sepolia · payouts in XSGD
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={connected ? "default" : "destructive"}>
              {connected ? "live" : dead ? "disconnected — check backend URL" : "reconnecting…"}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await enableSound();
                setSoundOn(soundEnabled());
              }}
            >
              {soundOn ? "🔔 sound on" : "🔕 enable sound"}
            </Button>
          </div>
        </header>

        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Payments</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{summary.count}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Net collected (XSGD)</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {formatUnits6(summary.net)}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>
                Saved vs {(CARD_FEE_BPS / 100).toFixed(1)}% cards
              </CardDescription>
              <CardTitle className="text-2xl tabular-nums text-primary">
                S${formatUnits6(summary.saved < 0n ? 0n : summary.saved)}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card className="flex-1">
          <CardHeader>
            <CardTitle className="text-base">
              Settlement feed
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Gantry fee {(GANTRY_FEE_BPS / 100).toFixed(1)}% · one rail, two doors
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Waiting for payments — scan the QR or send an agent.
              </p>
            ) : (
              <ul className="space-y-2">
                {rows.map((row) => (
                  <SettlementRow key={row.eventId} row={row} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
