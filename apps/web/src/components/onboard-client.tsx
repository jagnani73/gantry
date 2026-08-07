"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BASESCAN_BASE_URL,
  CATEGORY_OPTIONS,
  isValidHandle,
  type RegisterMerchantResponse,
} from "@gantry/shared";
import { api, ApiClientError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

/** Handle availability, checked live against GET /api/merchants/:handle. */
type Availability =
  | { name: "idle" }
  | { name: "invalid" }
  | { name: "checking" }
  | { name: "available" }
  | { name: "taken" }
  | { name: "unknown"; message: string };

type Step =
  | { name: "form" }
  | { name: "submitting" }
  | { name: "registered"; merchant: RegisterMerchantResponse }
  | { name: "failed"; errorName: string; message: string };

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const DEBOUNCE_MS = 400;
const INPUT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function OnboardClient() {
  const [handle, setHandle] = useState("");
  const [payout, setPayout] = useState("");
  const [categoryId, setCategoryId] = useState(CATEGORY_OPTIONS[0]?.id ?? 1);
  const [availability, setAvailability] = useState<Availability>({ name: "idle" });
  const [step, setStep] = useState<Step>({ name: "form" });
  const submitInFlight = useRef(false);

  useEffect(() => {
    if (handle === "") {
      setAvailability({ name: "idle" });
      return;
    }
    // The shared regex mirrors GantryCore._validateHandle, so a malformed
    // handle is rejected locally without burning a request.
    if (!isValidHandle(handle)) {
      setAvailability({ name: "invalid" });
      return;
    }

    setAvailability({ name: "checking" });
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .merchant(handle)
        .then(() => {
          if (!cancelled) setAvailability({ name: "taken" });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // 404 MerchantNotFound is the whole point — nobody has this handle.
          // Anything else (offline, CORS, 500) must NOT read as available, or
          // we walk the merchant into a submit that cannot succeed.
          if (err instanceof ApiClientError && err.errorName === "MerchantNotFound") {
            setAvailability({ name: "available" });
          } else {
            setAvailability({
              name: "unknown",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [handle]);

  const payoutValid = ADDRESS_REGEX.test(payout);
  const canSubmit = availability.name === "available" && payoutValid && step.name === "form";

  async function submit() {
    if (!canSubmit || submitInFlight.current) return;
    submitInFlight.current = true;
    setStep({ name: "submitting" });
    try {
      const merchant = await api.registerMerchant({
        handle,
        payout: payout as `0x${string}`,
        categoryId,
      });
      setStep({ name: "registered", merchant });
    } catch (err: unknown) {
      const errorName = err instanceof ApiClientError ? err.errorName : "NetworkError";
      // Someone took the handle between the availability check and the tx.
      // That is a "pick another name", not a failure worth a red card.
      if (errorName === "HandleTaken") {
        setAvailability({ name: "taken" });
        setStep({ name: "form" });
      } else {
        setStep({
          name: "failed",
          errorName,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      submitInFlight.current = false;
    }
  }

  return (
    <div className="dark min-h-dvh bg-background text-foreground">
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4 pt-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Start accepting payments</h1>
          <p className="text-sm text-muted-foreground">
            Pick a name, say where the money goes. You&apos;ll have a printable QR code and a
            live dashboard before your kopi gets cold.
          </p>
        </div>

        {(step.name === "form" || step.name === "submitting") && (
          <Card>
            <CardHeader>
              <CardTitle>Your shop</CardTitle>
              <CardDescription>Registered on Base Sepolia · payouts in XSGD</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="handle">
                  Shop handle
                </label>
                <Input
                  id="handle"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="ah-hock-chicken-rice"
                  value={handle}
                  disabled={step.name === "submitting"}
                  onChange={(e) => setHandle(e.target.value.toLowerCase())}
                />
                <AvailabilityHint availability={availability} handle={handle} />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="payout">
                  Payout address
                </label>
                <Input
                  id="payout"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="0x…"
                  value={payout}
                  disabled={step.name === "submitting"}
                  onChange={(e) => setPayout(e.target.value.trim())}
                />
                <p className="text-xs text-muted-foreground">
                  {payout === "" || payoutValid
                    ? "Every payment lands here as XSGD, minus the 0.5% protocol fee."
                    : "That doesn't look like a wallet address (0x + 40 hex characters)."}
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="category">
                  Category
                </label>
                <select
                  id="category"
                  className={INPUT_CLASS}
                  value={categoryId}
                  disabled={step.name === "submitting"}
                  onChange={(e) => setCategoryId(Number(e.target.value))}
                >
                  {CATEGORY_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Agents check this against their spend policy — a food budget can&apos;t buy
                  electronics.
                </p>
              </div>

              <Separator />

              <Button
                size="lg"
                className="w-full"
                disabled={!canSubmit}
                onClick={() => void submit()}
              >
                {step.name === "submitting" ? "Registering on-chain…" : "Register my shop"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Registration is a real on-chain transaction. On this demo deployment the relayer
                pays its gas, so you need no ETH.
              </p>
            </CardContent>
          </Card>
        )}

        {step.name === "registered" && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-3xl text-primary-foreground">
                ✓
              </div>
              <p className="text-2xl font-bold">{step.merchant.handle}</p>
              <p className="text-sm text-muted-foreground">
                Live on Base Sepolia · {step.merchant.categoryName} · paying out to{" "}
                <span className="tabular-nums">{shortAddr(step.merchant.payout)}</span>
              </p>
              <a
                className="text-sm text-primary underline underline-offset-4"
                href={`${BASESCAN_BASE_URL}/tx/${step.merchant.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View on Basescan
              </a>

              <div className="mt-2 flex w-full flex-col gap-2">
                <Button size="lg" className="w-full" asChild>
                  <Link href={`/qr/${step.merchant.handle}`}>Print your QR</Link>
                </Button>
                <Button size="lg" variant="outline" className="w-full" asChild>
                  <Link href={`/pay/${step.merchant.handle}`}>Open the payer page</Link>
                </Button>
                <Button size="lg" variant="outline" className="w-full" asChild>
                  <Link href={`/dashboard?handle=${step.merchant.handle}`}>
                    Open your dashboard
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step.name === "failed" && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive text-2xl text-destructive-foreground">
                ✕
              </div>
              <p className="font-semibold">{step.errorName}</p>
              <p className="text-sm text-muted-foreground">{step.message}</p>
              <Button variant="outline" onClick={() => setStep({ name: "form" })}>
                Back to the form
              </Button>
            </CardContent>
          </Card>
        )}

        <footer className="mt-auto pb-2 text-center text-xs text-muted-foreground">
          Gantry · one rail, two doors · settles in XSGD on Base Sepolia
        </footer>
      </main>
    </div>
  );
}

function AvailabilityHint({
  availability,
  handle,
}: {
  availability: Availability;
  handle: string;
}) {
  switch (availability.name) {
    case "idle":
      return (
        <p className="text-xs text-muted-foreground">
          Lowercase letters, numbers and hyphens. This becomes your QR code&apos;s address.
        </p>
      );
    case "invalid":
      return (
        <p className="text-xs text-destructive">
          Use 1–32 characters of a–z, 0–9 or -, not starting or ending with a hyphen.
        </p>
      );
    case "checking":
      return <p className="text-xs text-muted-foreground">Checking…</p>;
    case "available":
      return <p className="text-xs text-primary">{handle} is available.</p>;
    case "taken":
      return (
        <p className="text-xs text-destructive">
          {handle} is taken — pick another. Handles are claimed once, permanently.
        </p>
      );
    case "unknown":
      return (
        <p className="text-xs text-destructive">
          Couldn&apos;t check that handle: {availability.message}
        </p>
      );
  }
}
