"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  CARD_FEE_BPS,
  DEMO_MERCHANTS,
  GANTRY_FEE_BPS,
  formatUnits6,
  resolveScope,
  shouldChime,
  visibleRows,
  type SettlementEvent,
} from "@gantry/shared";
import { backendUrl } from "@/lib/env";
import { chime, enableSound, soundEnabled } from "@/lib/chime";
import { PolicyPanel } from "@/components/policy-panel";
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

  // `?handle=` scopes the feed to one merchant — what a shop that just onboarded
  // wants to see. Bare /dashboard keeps the all-merchants demo view.
  const scope = resolveScope(useSearchParams().get("handle"));
  // Read inside the SSE handler via a ref: putting `scope` in the effect deps
  // would tear down and reconnect the EventSource on every scope change.
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

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
      if (shouldChime(live, data.handle, scopeRef.current)) chime();
    });

    source.addEventListener("reset", () => {
      seen.current.clear();
      setRows([]);
    });

    return () => source.close();
  }, []);

  const visible = useMemo(() => visibleRows(rows, scope), [rows, scope]);

  const summary = useMemo(() => {
    const gross = visible.reduce((sum, row) => sum + BigInt(row.xsgdOut), 0n);
    const fees = visible.reduce((sum, row) => sum + BigInt(row.feeXsgd), 0n);
    const cardFees = (gross * BigInt(CARD_FEE_BPS)) / 10_000n;
    return { count: visible.length, net: gross - fees, saved: cardFees - fees };
  }, [visible]);

  const merchantName =
    scope === null
      ? (DEMO_MERCHANTS["ah-hock-chicken-rice"]?.displayName ?? "Merchant")
      : (DEMO_MERCHANTS[scope]?.displayName ?? scope);

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

        {/* A scoped feed hides other merchants' rows AND the policy panel, so
            without this banner an empty scoped dashboard is indistinguishable
            from a broken one — and at ?handle=ah-hock-chicken-rice the header
            alone renders identically to the unscoped view. */}
        {scope !== null && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              Showing only <span className="font-medium text-foreground">{scope}</span> · agent
              policy hidden
            </span>
            <Link className="shrink-0 text-primary underline underline-offset-2" href="/dashboard">
              show all merchants
            </Link>
          </div>
        )}

        {/* The policy panel belongs to the demo agent's wallet, not to any one
            merchant — showing it under a scoped feed would read as "this shop's
            agent policy", which it is not. */}
        {scope === null && <PolicyPanel />}

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
            {visible.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Waiting for payments — scan the QR or send an agent.
              </p>
            ) : (
              <ul className="space-y-2">
                {visible.map((row) => (
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
