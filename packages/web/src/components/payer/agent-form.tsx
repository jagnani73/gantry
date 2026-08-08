"use client";

import { useMemo, useState, type ReactNode } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { BASE_SEPOLIA_ADDRESSES, CATEGORY_OPTIONS, shortAddress } from "@gantry/shared";
import { Card, cn, Mono } from "@/components/primitives";
import { Input } from "@/components/ui/input";
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
 */

const AMOUNT = /^\d+(\.\d{1,2})?$/;

export function AgentForm({ wallet }: { wallet: Address | null }) {
  const { agents, agentName, setAgentName, rate: chainRate, refresh, popOverlay, replaceOverlay } =
    usePayer();
  const { createWallet, setPolicy, chainNow } = useAgentWrites();

  const existing = useMemo(
    () => (wallet ? (agents ?? []).find((a) => a.wallet.toLowerCase() === wallet.toLowerCase()) : undefined),
    [agents, wallet],
  );
  const rate = existing ? BigInt(existing.rate) : chainRate;

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
  const [days, setDays] = useState("30");

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const problem = validate({ wallet, signer, dailyCap, perTxCap, categories, days, rate });

  const submit = async () => {
    if (problem || !rate) return;
    setError(null);
    try {
      // The expiry is absolute on-chain and derived from CHAIN time: a laptop
      // running minutes fast would otherwise arm a policy the wallet considers
      // already dead.
      const expiry = (await chainNow()) + Number(days) * 86_400;
      const policy = {
        dailyCap: capUnitsFromSgd(dailyCap, rate),
        perTxCap: capUnitsFromSgd(perTxCap, rate),
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

          <Field label="Expires in" hint="Days from now. The wallet stores an absolute date.">
            <Input
              value={days}
              inputMode="numeric"
              onChange={(event) => setDays(event.target.value)}
              className="font-mono text-mono"
            />
          </Field>
        </Card>

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
          {busy ?? (wallet ? "Save rules" : "Create agent")}
        </button>
        <p className="px-1 text-center text-fine text-faint">
          {problem ??
            "You sign this yourself — no server can set or raise an agent's limits. Gas for it comes from the demo faucet."}
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
  if (!AMOUNT.test(input.dailyCap) || Number(input.dailyCap) <= 0) {
    return "The daily cap must be an amount above zero.";
  }
  if (!AMOUNT.test(input.perTxCap) || Number(input.perTxCap) <= 0) {
    return "The per-payment cap must be an amount above zero.";
  }
  if (Number(input.perTxCap) > Number(input.dailyCap)) {
    return "The per-payment cap cannot exceed the daily cap.";
  }
  if (input.categories.length === 0) {
    return "Pick at least one category — an agent allowed nowhere can never spend.";
  }
  if (!/^\d+$/.test(input.days) || Number(input.days) < 1 || Number(input.days) > 365) {
    return "Expiry must be between 1 and 365 days.";
  }
  return null;
}
