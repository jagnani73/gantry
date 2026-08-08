"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getAddress, isAddress, type Address } from "viem";
import {
  BASE_SEPOLIA_ADDRESSES,
  CATEGORY_OPTIONS,
  formatUnits6,
  shortAddress,
  type AgentSummary,
} from "@gantry/shared";
import { Card, cn, Mono } from "@/components/primitives";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { capUnitsFromSgd, categoryBitmapOf, categoryIdsOf, sgdFromCapUnits } from "./agent-rules";
import { useAgentWrites } from "./agent-writes";
import { OverlayHeader, OverlayScreen } from "./overlay";
import { usePayer } from "./payer-context";

/**
 * Create an agent, or change the rules of one.
 *
 * The signer address is a real input and cannot be derived: it is the public
 * address of whatever software will act as the agent — in this demo, the CLI's
 * session key. The app never holds that key, which is the whole point: the agent
 * signs spend authorizations, the wallet checks them against a policy only the
 * owner can set, and the owner is the person holding this phone.
 *
 * Editing has one rule that outranks the rest: `setPolicy` OVERWRITES the whole
 * policy struct and zeroes the wallet's `spentToday`, so every field must be
 * prefilled from what is actually on-chain and a save that changes nothing must
 * not be sent at all. The form therefore refuses to render until it has read the
 * policy it is about to replace.
 */

/** Caps are typed the way a price is: at most two decimals. */
const AMOUNT = /^\d+(\.\d{1,2})?$/;
const DEFAULT_DAYS = "30";
const MAX_DAYS = 365;
const DAY_SECONDS = 86_400;

export function AgentForm({ wallet }: { wallet: Address | null }) {
  const { agents, popOverlay } = usePayer();

  const listed = useMemo(
    () =>
      wallet ? (agents ?? []).find((a) => a.wallet.toLowerCase() === wallet.toLowerCase()) : undefined,
    [agents, wallet],
  );

  // Read the wallet directly, exactly as the detail screen does. The list is
  // enumerated from factory logs and lags — right after creating a wallet it has
  // no entry at all — and prefilling the edit form from a missing entry would
  // silently rewrite a live policy with this file's defaults.
  const [fresh, setFresh] = useState<AgentSummary | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    setReadError(null);
    api
      .agent(wallet)
      .then((summary) => {
        if (!cancelled) setFresh(summary);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn(`gantry: agent read failed for ${wallet}`, err);
        setReadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, reloadNonce]);

  const existing = fresh ?? listed;

  if (wallet && !existing) {
    return (
      <OverlayScreen>
        <OverlayHeader
          onBack={popOverlay}
          backLabel="Back"
          title="Edit rules"
          subtitle={shortAddress(wallet)}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          {readError === null ? (
            <p className="text-body text-muted">Reading this agent&apos;s current rules…</p>
          ) : (
            <>
              <p className="text-body text-muted">
                We couldn&apos;t read this agent&apos;s current rules, and saving would overwrite
                every one of them. Nothing has changed on-chain.
              </p>
              <p className="max-w-[34ch] text-fine text-faint break-words">{readError}</p>
              <button
                type="button"
                onClick={() => setReloadNonce((n) => n + 1)}
                className="focus-ring h-12 rounded-control-m bg-ink px-6 text-btn-sm text-paper transition-colors hover:bg-ink-hover"
              >
                Try again
              </button>
            </>
          )}
        </div>
      </OverlayScreen>
    );
  }

  // Keyed so a different wallet remounts rather than keeping the last one's
  // prefilled fields — every value below is a `useState` initializer.
  return <AgentFormFields key={wallet ?? "new"} wallet={wallet} existing={existing} />;
}

function AgentFormFields({
  wallet,
  existing,
}: {
  wallet: Address | null;
  existing: AgentSummary | undefined;
}) {
  const {
    agentName,
    setAgentName,
    rate: chainRate,
    chainNow: clock,
    refresh,
    popOverlay,
    replaceOverlay,
  } = usePayer();
  const { createWallet, setPolicy, chainNow } = useAgentWrites();

  const rate = existing ? BigInt(existing.rate) : chainRate;

  // Chain seconds as of the moment this form opened. Frozen so the prefilled
  // "expires in" and the "did the payer touch it" comparison cannot drift apart
  // while the form is on screen.
  const [openedAt] = useState(() => clock());
  const initialDays = daysRemaining(existing, openedAt);
  /** The absolute expiry already on-chain, when it is still in the future. An
   * untouched expiry field re-sends THIS rather than `now + days`, so opening
   * the form to add a category cannot quietly move the date. */
  const preservedExpiry = existing && existing.expiry > openedAt ? existing.expiry : null;

  const [name, setName] = useState(() => (wallet ? (agentName(wallet) ?? "") : ""));
  const [signer, setSigner] = useState(existing?.agentSigner ?? "");
  const [dailyCap, setDailyCap] = useState(() =>
    existing && rate ? sgdFromCapUnits(existing.dailyCap, rate) : "50.00",
  );
  const [perTxCap, setPerTxCap] = useState(() =>
    existing && rate ? sgdFromCapUnits(existing.perTxCap, rate) : "10.00",
  );
  const [categories, setCategories] = useState<number[]>(() =>
    existing ? categoryIdsOf(BigInt(existing.categoryBitmap)) : [1],
  );
  const [days, setDays] = useState(initialDays);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const problem = validate({ wallet, signer, dailyCap, perTxCap, categories, days, rate });

  const expiryUnchanged = preservedExpiry !== null && days === initialDays;
  /** Every field the CONTRACT stores is identical to what it already holds, so
   * there is nothing to write. Compared in contract units, not in S$, because
   * that is what `setPolicy` will be handed. */
  const writesNothing =
    existing !== undefined &&
    problem === null &&
    rate !== null &&
    expiryUnchanged &&
    capUnitsFromSgd(dailyCap.trim(), rate) === BigInt(existing.dailyCap) &&
    capUnitsFromSgd(perTxCap.trim(), rate) === BigInt(existing.perTxCap) &&
    categoryBitmapOf(categories) === BigInt(existing.categoryBitmap);

  // `setPolicy` zeroes `_spentToday`. That is deliberate — it is what makes the
  // rehearsal re-arm work — but it is also an allowance the agent gets back, so
  // it is stated BEFORE the payer taps Save rather than discovered afterwards.
  const resetsCounter =
    existing !== undefined && !writesNothing && BigInt(existing.spentToday) > 0n && rate !== null;

  const submit = async () => {
    if (problem || !rate) return;
    setError(null);
    try {
      if (wallet && writesNothing) {
        // No transaction: nothing on-chain differs. Saving anyway would cost gas
        // for no change AND hand the agent a fresh daily allowance — after
        // editing only the display name, a field this form promises never
        // leaves the browser.
        if (name.trim()) setAgentName(wallet, name.trim());
        popOverlay();
        return;
      }

      // The expiry is absolute on-chain and derived from CHAIN time: a laptop
      // running minutes fast would otherwise arm a policy the wallet considers
      // already dead. An untouched field keeps the date the wallet already has.
      const expiry = expiryUnchanged
        ? preservedExpiry!
        : (await chainNow()) + Number(days) * DAY_SECONDS;
      const policy = {
        dailyCap: capUnitsFromSgd(dailyCap.trim(), rate),
        perTxCap: capUnitsFromSgd(perTxCap.trim(), rate),
        expiry,
        categoryBitmap: categoryBitmapOf(categories),
      };

      if (wallet) {
        setBusy("Updating the policy on-chain…");
        await setPolicy(wallet, policy);
        if (name.trim()) setAgentName(wallet, name.trim());
        refresh();
        popOverlay();
        return;
      }

      setBusy("Creating the wallet on-chain…");
      const created = await createWallet(getAddress(signer.trim()));
      setBusy("Arming its spend policy…");
      await setPolicy(created.wallet, policy);
      if (name.trim()) setAgentName(created.wallet, name.trim());
      refresh();
      replaceOverlay({ kind: "agent", wallet: created.wallet });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <OverlayScreen>
      <OverlayHeader
        onBack={popOverlay}
        backLabel="Back"
        title={wallet ? "Edit rules" : "New agent"}
        subtitle={wallet ? shortAddress(wallet) : undefined}
      />
      <div className="flex flex-col gap-3.5 px-5 pt-6 pb-11">
        <Card radius="card-m" pad="none" className="flex flex-col gap-4 px-5 py-5">
          <Field label="Name" hint="Yours alone — it stays in this browser and never leaves it.">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Kopi Runner"
              maxLength={40}
            />
          </Field>

          <Field
            label="Agent signer"
            hint={
              wallet
                ? "Fixed for the life of this wallet."
                : "The public address of the software that will act as this agent."
            }
          >
            <Input
              value={signer}
              onChange={(event) => setSigner(event.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              disabled={Boolean(wallet)}
              className="font-mono text-mono"
            />
          </Field>
        </Card>

        <Card radius="card-m" pad="none" className="flex flex-col gap-4 px-5 py-5">
          <div className="flex gap-3">
            <Field label="Daily cap" className="flex-1">
              <Input
                value={dailyCap}
                inputMode="decimal"
                onChange={(event) => setDailyCap(event.target.value)}
                className="font-mono text-mono"
              />
            </Field>
            <Field label="Per payment" className="flex-1">
              <Input
                value={perTxCap}
                inputMode="decimal"
                onChange={(event) => setPerTxCap(event.target.value)}
                className="font-mono text-mono"
              />
            </Field>
          </div>
          <p className="text-fine text-faint">
            In S$. The contract stores USDC, so these convert at the swap&apos;s owner-set rate and
            the wallet enforces the converted figure.
          </p>

          <Field label="Allowed at">
            <div className="flex flex-wrap gap-2">
              {CATEGORY_OPTIONS.map((option) => {
                const on = categories.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setCategories((prev) =>
                        prev.includes(option.id)
                          ? prev.filter((id) => id !== option.id)
                          : [...prev, option.id],
                      )
                    }
                    className={cn(
                      "focus-ring rounded-chip px-3 py-2 text-chip transition-colors",
                      on ? "bg-accent-tint text-accent" : "bg-fill-subtle text-quiet",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field
            label="Expires in"
            hint={
              existing
                ? "Days from now. Leave it alone and the date already on the wallet is kept."
                : "Days from now. The wallet stores an absolute date."
            }
          >
            <Input
              value={days}
              inputMode="numeric"
              onChange={(event) => setDays(event.target.value)}
              className="font-mono text-mono"
            />
          </Field>
        </Card>

        {resetsCounter && existing && rate ? (
          <Card tone="sunken" radius="control-m" pad="none" className="px-4.5 py-4">
            <p className="text-meta-sm text-muted">
              Saving replaces the whole policy on-chain, which also resets today&apos;s spend
              counter. This agent has spent S${sgdFromCapUnits(existing.spentToday, rate)} today; a
              save gives it the full daily cap again until the window rolls at 08:00 SGT.
            </p>
          </Card>
        ) : null}

        {error ? (
          <Card tone="danger" radius="control-m" pad="none" className="px-4.5 py-4">
            <p className="text-meta break-words">{error}</p>
          </Card>
        ) : null}

        <button
          type="button"
          disabled={Boolean(problem) || busy !== null}
          onClick={() => void submit()}
          className="focus-ring h-13.5 rounded-control-m bg-ink text-btn text-paper transition-colors hover:bg-ink-hover disabled:bg-nav-active disabled:text-faintest"
        >
          {busy ?? (wallet ? (writesNothing ? "Done" : "Save rules") : "Create agent")}
        </button>
        <p className="px-1 text-center text-fine text-faint">
          {problem ??
            (writesNothing
              ? "Nothing here differs from the wallet, so no transaction is sent — only the name is stored."
              : "You sign this yourself — no server can set or raise an agent's limits. Gas for it comes from the demo faucet.")}
        </p>
        {wallet ? null : (
          <Mono size="2xs" tone="faintest" className="px-1 text-center">
            factory {shortAddress(BASE_SEPOLIA_ADDRESSES.agentPbmFactory)}
          </Mono>
        )}
      </div>
    </OverlayScreen>
  );
}

/**
 * The "expires in" field, prefilled from the wallet.
 *
 * Hardcoding it collapsed a 365-day policy to 30 the moment someone opened the
 * form to add a category. A policy that is revoked or has already lapsed has no
 * date worth preserving, so it falls back to the default rather than prefilling
 * a spent one.
 */
function daysRemaining(existing: AgentSummary | undefined, now: number): string {
  if (!existing) return DEFAULT_DAYS;
  const remaining = Math.ceil((existing.expiry - now) / DAY_SECONDS);
  if (!Number.isFinite(remaining) || remaining < 1) return DEFAULT_DAYS;
  return String(Math.min(remaining, MAX_DAYS));
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.75", className)}>
      <span className="text-key font-medium">{label}</span>
      {children}
      {hint ? <span className="text-fine text-faint">{hint}</span> : null}
    </label>
  );
}

/**
 * A cap the payer typed → the units the contract will store, or null.
 *
 * The same conversion the writer uses, so the two cannot disagree about what a
 * given string means — validating with `Number()` while writing with
 * `parseSgd`/bigint left the accepted decimal places up to two independent
 * parsers.
 */
function capUnits(input: string, rate: bigint): bigint | null {
  const trimmed = input.trim();
  if (!AMOUNT.test(trimmed)) return null;
  try {
    const units = capUnitsFromSgd(trimmed, rate);
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

/** One message at a time, in the order a person fills the form in. */
function validate(input: {
  wallet: Address | null;
  signer: string;
  dailyCap: string;
  perTxCap: string;
  categories: number[];
  days: string;
  rate: bigint | null;
}): string | null {
  if (!input.rate) return "The swap's rate could not be read, so caps cannot be converted yet.";
  if (!input.wallet && !isAddress(input.signer.trim())) {
    return "The agent signer must be a wallet address.";
  }
  const daily = capUnits(input.dailyCap, input.rate);
  if (daily === null) {
    return "The daily cap must be an amount above zero, with at most two decimals.";
  }
  const perTx = capUnits(input.perTxCap, input.rate);
  if (perTx === null) {
    return "The per-payment cap must be an amount above zero, with at most two decimals.";
  }
  // Compared as the CONTRACT will see them: both caps are ceiled into token
  // units before `authorizeSpend` ever compares them.
  if (perTx > daily) {
    return `The per-payment cap cannot exceed the daily cap (${formatUnits6(perTx, 6)} > ${formatUnits6(daily, 6)} USDC).`;
  }
  if (input.categories.length === 0) {
    return "Pick at least one category — an agent allowed nowhere can never spend.";
  }
  if (!/^\d+$/.test(input.days) || Number(input.days) < 1 || Number(input.days) > MAX_DAYS) {
    return `Expiry must be between 1 and ${MAX_DAYS} days.`;
  }
  return null;
}
