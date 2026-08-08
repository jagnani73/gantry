"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits6, type PolicyResponse } from "@gantry/shared";
import { api, ApiClientError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * On-chain agent policy panel: cap meter + Revoke. Reads GET /api/policy on a
 * 10s poll (the wallet's SpendAuthorized/PolicySet state is chain-truth; the
 * poll keeps the meter honest after each agent payment without SSE plumbing).
 * Renders nothing until the first successful poll. There is no "unconfigured"
 * case left — the wallet is a committed constant, and the
 * PolicyWalletUnconfigured branch that used to justify a blank panel is gone —
 * so a blank panel means only that the backend has not answered yet.
 */

const POLL_MS = 10_000;

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Raw 6dp token units → S$ display via the pinned rate (honest-labels note:
 * caps live on-chain in token units; S$ is the display conversion). */
function toSgd(units: string, rate: string): string {
  return formatUnits6((BigInt(units) * BigInt(rate)) / 1_000_000n);
}

export function PolicyPanel() {
  const [policy, setPolicy] = useState<PolicyResponse | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPolicy(await api.policy());
    } catch (err) {
      // Failures keep the last-known state — a flaky poll must not blank the
      // panel mid-demo. Logged so a dead backend URL is diagnosable. The panel
      // stays hidden until the first successful read (`!policy` below), which
      // also covers a backend that cannot reach the wallet at all.
      console.warn("policy poll failed", err);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!policy) return null;

  const spent = BigInt(policy.spentToday);
  const cap = BigInt(policy.dailyCap);
  const pct = cap === 0n ? 100 : Math.min(100, Number((spent * 100n) / cap));
  const expiryDate = policy.expiry
    ? new Date(policy.expiry * 1000).toLocaleDateString("en-SG", { day: "numeric", month: "short" })
    : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            Agent spend policy
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              on-chain PBM wallet {shortAddr(policy.wallet)} ·{" "}
              <Link href="/agent" className="underline">
                owner console
              </Link>
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            {policy.revoked ? (
              <Badge variant="destructive">revoked</Badge>
            ) : (
              <Badge variant="secondary">active</Badge>
            )}
            <Button
              variant="destructive"
              size="sm"
              disabled={policy.revoked || revoking}
              onClick={async () => {
                if (!window.confirm("Revoke the agent's spend policy on-chain?")) return;
                setRevoking(true);
                setRevokeError(null);
                try {
                  await api.revokePolicy();
                  // The tx confirmed before this resolved, so the policy IS
                  // revoked. Set it locally instead of trusting the read that
                  // follows: a lagging replica answers with the pre-revoke state
                  // and the button springs back to "Revoke", which on stage reads
                  // as a failure. The poll reconciles a beat later either way.
                  setPolicy((p) => (p ? { ...p, revoked: true, expiry: 0 } : p));
                  void refresh();
                } catch (err) {
                  // The most theatrical button in the demo must never fail
                  // silently — surface WHY (disabled route, relayer, RPC).
                  console.error("revoke failed", err);
                  setRevokeError(
                    err instanceof ApiClientError ? `${err.errorName}: ${err.message}` : String(err),
                  );
                } finally {
                  setRevoking(false);
                }
              }}
            >
              {revoking ? "revoking…" : "Revoke"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="h-2 overflow-hidden rounded bg-muted">
          <div
            className={`h-full rounded transition-all ${pct >= 100 || policy.revoked ? "bg-destructive" : "bg-primary"}`}
            style={{ width: policy.revoked ? "100%" : `${pct}%` }}
          />
        </div>
        <p className="text-sm text-muted-foreground tabular-nums">
          {policy.revoked ? (
            <>Policy revoked — every agent payment now reverts on-chain (PolicyExpired).</>
          ) : (
            <>
              S${toSgd(policy.spentToday, policy.rate)} of S${toSgd(policy.dailyCap, policy.rate)}{" "}
              spent today{" "}
              <span title="Caps live on-chain in token units; S$ shown at the owner-set demo rate (no market, no oracle)">
                @ {(Number(policy.rate) / 1e6).toFixed(4)}
              </span>{" "}
              · {policy.categories.join(", ") || "no categories"}
              {expiryDate ? <> · expires {expiryDate}</> : null} · wallet holds{" "}
              <span className={BigInt(policy.balance) < 3_352_955n ? "text-destructive" : undefined}>
                S${toSgd(policy.balance, policy.rate)}
              </span>{" "}
              · signer {shortAddr(policy.agentSigner)}
            </>
          )}
        </p>
        {revokeError ? <p className="text-sm text-destructive">revoke failed — {revokeError}</p> : null}
      </CardContent>
    </Card>
  );
}
