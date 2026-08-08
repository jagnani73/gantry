"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BASESCAN_BASE_URL,
  CATEGORY_OPTIONS,
  formatUnits6,
  type PolicyResponse,
} from "@gantry/shared";
import { api, ApiClientError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * The agent OWNER's console — the human who funds the wallet and sets its
 * limits. Deliberately a separate page from the merchant dashboard: the policy
 * belongs to the agent's owner, not to the hawker being paid, and the panel
 * living on the dashboard only reads coherently because one person plays both
 * roles in the demo.
 *
 * Every number here is read from the chain, and every edit is an on-chain
 * `setPolicy`. Nothing is stored in this app.
 */

const POLL_MS = 10_000;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Token units → S$ at the owner-set rate, the same conversion the panel shows. */
function toSgd(units: string, rate: string): string {
  return formatUnits6((BigInt(units) * BigInt(rate)) / 1_000_000n);
}

/** What one demo purchase costs, so an underfunded wallet is legible BEFORE the
 * agent fails. Under this and the facilitator's balance pre-check rejects with
 * insufficient_funds — which on stage reads as a broken demo rather than a
 * policy denial. */
const DRINKS_ORDER_UNITS = 3_352_955n;

type Saving = { name: "idle" } | { name: "saving" } | { name: "error"; message: string };

export function AgentClient() {
  const [policy, setPolicy] = useState<PolicyResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState<Saving>({ name: "idle" });
  const [revoking, setRevoking] = useState(false);

  // Form state, seeded from chain once the first read lands.
  const [dailyCap, setDailyCap] = useState("");
  const [perTxCap, setPerTxCap] = useState("");
  const [expiryDays, setExpiryDays] = useState("30");
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [seeded, setSeeded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.policy();
      setPolicy(next);
      setStale(false);
      return next;
    } catch (err) {
      // Keep the last-known numbers — a flaky poll must not blank the console —
      // but say the reading is stale, because a frozen meter and a live one with
      // no new spends are pixel-identical.
      console.warn("policy poll failed", err);
      setStale(true);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Seed the form from chain exactly once, so a poll landing mid-edit cannot
  // overwrite what the owner is typing.
  useEffect(() => {
    if (!policy || seeded) return;
    setDailyCap(toSgd(policy.dailyCap, policy.rate));
    setPerTxCap(toSgd(policy.perTxCap, policy.rate));
    setCategoryIds(
      CATEGORY_OPTIONS.filter((c) => (BigInt(policy.categoryBitmap) >> BigInt(c.id)) & 1n).map((c) => c.id),
    );
    setSeeded(true);
  }, [policy, seeded]);

  if (!policy) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p className="text-sm text-muted-foreground">
          {stale ? "Cannot reach the backend — is it running?" : "Reading the wallet from chain…"}
        </p>
      </main>
    );
  }

  const balance = BigInt(policy.balance);
  const spent = BigInt(policy.spentToday);
  const cap = BigInt(policy.dailyCap);
  const pct = cap === 0n ? 100 : Math.min(100, Number((spent * 100n) / cap));
  const underfunded = balance < DRINKS_ORDER_UNITS;
  const expiryDate = policy.expiry
    ? new Date(policy.expiry * 1000).toLocaleString("en-SG", { dateStyle: "medium" })
    : null;
  const lapsed = policy.expiry > 0 && policy.expiry * 1000 < Date.now();

  async function save() {
    setSaving({ name: "saving" });
    try {
      // The response carries the re-read policy, so the console never depends on
      // a follow-up read that a lagging replica could answer with pre-write state.
      const { policy: next } = await api.setPolicy({
        dailyCapSgd: dailyCap,
        perTxCapSgd: perTxCap,
        categoryIds,
        expiryDays: Number(expiryDays),
      });
      setPolicy(next);
      setStale(false);
      setSaving({ name: "idle" });
    } catch (err) {
      setSaving({
        name: "error",
        message: err instanceof ApiClientError ? `${err.errorName}: ${err.message}` : String(err),
      });
    }
  }

  async function revoke() {
    if (!window.confirm("Revoke the agent's spend policy on-chain?")) return;
    setRevoking(true);
    setSaving({ name: "idle" });
    try {
      await api.revokePolicy();
      // The transaction confirmed before this resolved, so the policy IS revoked.
      // Setting it locally rather than re-reading avoids the flicker where a
      // lagging replica answers with the pre-revoke state and the button springs
      // back to "Revoke", looking like it failed.
      setPolicy((p) => (p ? { ...p, revoked: true, expiry: 0 } : p));
      void refresh();
    } catch (err) {
      setSaving({
        name: "error",
        message: err instanceof ApiClientError ? `${err.errorName}: ${err.message}` : String(err),
      });
    } finally {
      setRevoking(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Agent console</h1>
        <Link href="/dashboard" className="text-sm text-muted-foreground underline">
          merchant dashboard →
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        Your agent&apos;s spending rules live on-chain in a Purpose-Bound Money wallet. Nothing here
        is stored by Gantry — every value is read from the wallet, and every change is a transaction.
      </p>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Wallet</CardTitle>
            {policy.revoked ? (
              <Badge variant="destructive">revoked</Badge>
            ) : lapsed ? (
              <Badge variant="destructive">expired</Badge>
            ) : (
              <Badge variant="secondary">active</Badge>
            )}
          </div>
          <CardDescription>
            <a
              href={`${BASESCAN_BASE_URL}/address/${policy.wallet}`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {shortAddr(policy.wallet)}
            </a>{" "}
            · agent signer {shortAddr(policy.agentSigner)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">Balance</span>
            <span className="tabular-nums">
              {formatUnits6(balance)} {policy.token}{" "}
              <span className="text-muted-foreground">≈ S${toSgd(policy.balance, policy.rate)}</span>
            </span>
          </div>
          {underfunded ? (
            <p className="text-sm text-destructive">
              Below one demo purchase (S${formatUnits6((DRINKS_ORDER_UNITS * BigInt(policy.rate)) / 1_000_000n)}).
              Payments will fail as <code>insufficient_funds</code> before any policy check runs — top
              up with <code>pnpm demo:reset</code>.
            </p>
          ) : null}

          <div className="h-2 overflow-hidden rounded bg-muted">
            <div
              className={`h-full rounded transition-all ${pct >= 100 || policy.revoked ? "bg-destructive" : "bg-primary"}`}
              style={{ width: policy.revoked ? "100%" : `${pct}%` }}
            />
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">
            {policy.revoked ? (
              <>Revoked — every agent payment now reverts on-chain (PolicyExpired).</>
            ) : (
              <>
                S${toSgd(policy.spentToday, policy.rate)} of S${toSgd(policy.dailyCap, policy.rate)} spent
                today{" "}
                <span title="Caps are stored on-chain in token units; S$ is a display conversion at the owner-set demo rate — no market, no oracle">
                  @ {(Number(policy.rate) / 1e6).toFixed(4)}
                </span>
                {expiryDate ? <> · expires {expiryDate}</> : null}
              </>
            )}
          </p>
          {stale ? (
            <p className="text-sm text-destructive">Not updating — the last read failed.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Spending rules</CardTitle>
          <CardDescription>
            Saving writes <code>setPolicy</code> to the wallet — which also resets today&apos;s spend
            counter.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Daily cap (S$)</span>
              <Input value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} inputMode="decimal" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Per-payment cap (S$)</span>
              <Input value={perTxCap} onChange={(e) => setPerTxCap(e.target.value)} inputMode="decimal" />
            </label>
          </div>

          <div className="space-y-1 text-sm">
            <span className="text-muted-foreground">Allowed categories</span>
            <div className="flex flex-wrap gap-2 pt-1">
              {CATEGORY_OPTIONS.map((c) => {
                const on = categoryIds.includes(c.id);
                return (
                  <Button
                    key={c.id}
                    type="button"
                    size="sm"
                    variant={on ? "default" : "outline"}
                    onClick={() =>
                      setCategoryIds((ids) =>
                        on ? ids.filter((i) => i !== c.id) : [...ids, c.id].sort((a, b) => a - b),
                      )
                    }
                  >
                    {c.label}
                  </Button>
                );
              })}
            </div>
          </div>

          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Expires in (days)</span>
            <Input
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
              inputMode="numeric"
              className="max-w-32"
            />
          </label>

          {saving.name === "error" ? (
            <p className="text-sm text-destructive">{saving.message}</p>
          ) : null}

          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={saving.name === "saving" || revoking}>
              {saving.name === "saving" ? "saving…" : "Save rules"}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void revoke()}
              disabled={policy.revoked || revoking || saving.name === "saving"}
            >
              {revoking ? "revoking…" : "Revoke"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
