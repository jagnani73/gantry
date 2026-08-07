"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi } from "viem";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  BASESCAN_BASE_URL,
  formatUnits6,
  parseSgd,
  reviveTypedData,
  type IntentResponse,
  type MerchantResponse,
} from "@gantry/shared";
import { api, ApiClientError } from "@/lib/api";
import { getBurnerAccount } from "@/lib/burner";
import { burnerEnvEnabled, walletPayToken } from "@/lib/env";
import { AmountPad } from "@/components/amount-pad";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

type Step =
  | { name: "loading" }
  | { name: "entry" }
  | { name: "quoting" }
  | { name: "review"; intent: IntentResponse }
  | { name: "preparing"; intent: IntentResponse }
  | { name: "funding"; intent: IntentResponse }
  | { name: "signing"; intent: IntentResponse }
  | { name: "settling"; intent: IntentResponse }
  | { name: "settled"; intent: IntentResponse; txHash: string; xsgdOut: string }
  | { name: "failed"; intent: IntentResponse | null; errorName: string; message: string };

// Computed during render (not effect-seeded state) so a fresh quote never
// paints a one-frame "expired" flash before the first tick lands.
function useCountdown(expiry: number | undefined): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!expiry) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [expiry]);
  return expiry ? Math.max(0, expiry - now) : 0;
}

export function PayClient({ handle }: { handle: string }) {
  const [merchant, setMerchant] = useState<MerchantResponse | null>(null);
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [amount, setAmount] = useState("");
  // Env-only, so it is known at first render — no URL to read, no flicker.
  const [burner] = useState(burnerEnvEnabled);

  const { address: walletAddress, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();

  useEffect(() => {
    let cancelled = false;
    api
      .merchant(handle)
      .then((m) => {
        if (cancelled) return;
        setMerchant(m);
        setStep({ name: "entry" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStep({
          name: "failed",
          intent: null,
          errorName: err instanceof ApiClientError ? err.errorName : "NetworkError",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  const fail = useCallback((intent: IntentResponse | null, err: unknown) => {
    // A settle that raced a retry (or a dropped response + retry) comes back
    // as 409 IntentAlreadySettled WITH the tx hash — that's a success, and
    // rendering it as failure while the dashboard chimes is the worst split.
    if (intent && err instanceof ApiClientError && err.errorName === "IntentAlreadySettled") {
      const txHash = (err.args as { txHash?: string } | undefined)?.txHash;
      if (txHash) {
        setStep({ name: "settled", intent, txHash, xsgdOut: intent.xsgdAmount });
        return;
      }
    }
    setStep({
      name: "failed",
      intent,
      errorName: err instanceof ApiClientError ? err.errorName : "Error",
      message: err instanceof Error ? err.message : String(err),
    });
  }, []);

  const quote = useCallback(async () => {
    setStep({ name: "quoting" });
    try {
      const xsgdAmount = parseSgd(amount).toString();
      const intent = await api.createIntent({
        handle,
        xsgdAmount,
        token: burner ? "MUSDC" : walletPayToken(),
      });
      setStep({ name: "review", intent });
    } catch (err) {
      fail(null, err);
    }
  }, [amount, burner, handle, fail]);

  const requote = useCallback(async (old: IntentResponse) => {
    setStep({ name: "quoting" });
    try {
      const intent = await api.requote(old.intentId);
      setStep({ name: "review", intent });
    } catch (err) {
      fail(old, err);
    }
  }, [fail]);

  const confirmInFlight = useRef(false);

  const confirm = useCallback(
    async (intent: IntentResponse) => {
      if (confirmInFlight.current) return; // phone double-tap guard
      if (!burner && !walletAddress) return; // ConnectButton shown instead
      confirmInFlight.current = true;
      setStep({ name: "preparing", intent });
      try {
        let payer: `0x${string}`;
        let signature: `0x${string}`;

        if (burner) {
          const account = getBurnerAccount();
          payer = account.address;
          if (publicClient) {
            const readBalance = () =>
              publicClient.readContract({
                address: intent.tokenIn,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [payer],
              });
            if ((await readBalance()) < BigInt(intent.amountIn)) {
              setStep({ name: "funding", intent });
              await api.faucet(payer);
              // The mint is mined, but RPC replicas can lag — wait until the
              // balance is actually visible before signing.
              for (let i = 0; (await readBalance()) < BigInt(intent.amountIn); i++) {
                if (i >= 10) throw new Error("faucet funds not visible yet — try again");
                await new Promise((resolve) => setTimeout(resolve, 1500));
              }
            }
          }
          setStep({ name: "signing", intent });
          signature = await account.signTypedData(reviveTypedData(intent.typedData, payer));
        } else {
          payer = walletAddress!;
          if (chainId !== baseSepolia.id) {
            await switchChainAsync({ chainId: baseSepolia.id });
          }
          setStep({ name: "signing", intent });
          signature = await signTypedDataAsync(reviveTypedData(intent.typedData, payer));
        }

        setStep({ name: "settling", intent });
        const settled = await api.settle(intent.intentId, {
          payer,
          signature,
          validBefore: intent.validBefore,
        });
        setStep({ name: "settled", intent, txHash: settled.txHash, xsgdOut: settled.xsgdOut });
      } catch (err) {
        fail(intent, err);
      } finally {
        confirmInFlight.current = false;
      }
    },
    [burner, chainId, fail, publicClient, signTypedDataAsync, switchChainAsync, walletAddress],
  );

  const activeIntent = "intent" in step ? step.intent : null;
  const countdown = useCountdown(step.name === "review" ? step.intent.expiry : undefined);
  const expired = step.name === "review" && countdown === 0;

  const busyLabel = useMemo(() => {
    switch (step.name) {
      case "quoting":
        return "Locking your rate…";
      case "preparing":
        return "Preparing payment…";
      case "funding":
        return "Funding demo wallet…";
      case "signing":
        return "Waiting for signature…";
      case "settling":
        return "Settling on Base Sepolia…";
      default:
        return null;
    }
  }, [step.name]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4 pt-8">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">{merchant?.displayName ?? handle}</h1>
          {merchant?.location && (
            <p className="text-sm text-muted-foreground">{merchant.location}</p>
          )}
        </div>
        {burner && <Badge variant="secondary">demo wallet</Badge>}
      </header>

      {step.name === "loading" && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      )}

      {step.name === "entry" && (
        <AmountPad
          value={amount}
          onChange={setAmount}
          onSubmit={quote}
          // Faucet mints 100 USDC ≈ S$134 — cap below it so burner payments can't strand.
          max={burner ? 130 : 9999}
          maxHint={burner ? "Demo wallet caps at S$130" : undefined}
        />
      )}

      {busyLabel && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">{busyLabel}</p>
            {activeIntent && (
              <p className="text-lg font-semibold">
                S${formatUnits6(BigInt(activeIntent.xsgdAmount))}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {step.name === "review" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-3xl">
              S${formatUnits6(BigInt(step.intent.xsgdAmount))}
            </CardTitle>
            <CardDescription>
              {expired
                ? "Quote expired — get a fresh rate"
                : `Rate locked · expires in ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, "0")}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">You pay</span>
                <span>
                  {formatUnits6(BigInt(step.intent.amountIn), 6)} {step.intent.tokenSymbol}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Merchant receives</span>
                <span>{formatUnits6(BigInt(step.intent.xsgdAmount))} XSGD</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Rate</span>
                <span>1 USDC = {formatUnits6(BigInt(step.intent.rate), 4)} SGD</span>
              </div>
            </div>
            <Separator />
            {expired ? (
              <Button size="lg" className="w-full" onClick={() => requote(step.intent)}>
                Get new quote
              </Button>
            ) : burner || walletAddress ? (
              <Button size="lg" className="w-full" onClick={() => confirm(step.intent)}>
                Confirm &amp; pay — no gas needed
              </Button>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <p className="text-sm text-muted-foreground">Connect a wallet to sign</p>
                <ConnectButton showBalance={false} />
              </div>
            )}
            <p className="text-center text-xs text-muted-foreground">
              You sign once; the relayer pays gas. Funds move only for this exact payment.
            </p>
          </CardContent>
        </Card>
      )}

      {step.name === "settled" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-3xl text-primary-foreground">
              ✓
            </div>
            <p className="text-2xl font-bold">
              Paid S${formatUnits6(BigInt(step.intent.xsgdAmount))}
            </p>
            <p className="text-sm text-muted-foreground">
              {merchant?.displayName ?? handle} received{" "}
              {formatUnits6(BigInt(step.xsgdOut), 2)} XSGD
            </p>
            <a
              className="text-sm text-primary underline underline-offset-4"
              href={`${BASESCAN_BASE_URL}/tx/${step.txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View on Basescan
            </a>
            <Button
              variant="outline"
              onClick={() => {
                setAmount("");
                setStep({ name: "entry" });
              }}
            >
              New payment
            </Button>
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
            {step.intent &&
            (step.errorName === "IntentExpired" || step.errorName === "IntentWasCancelled") ? (
              <Button onClick={() => requote(step.intent!)}>Get new quote</Button>
            ) : step.intent ? (
              <Button onClick={() => setStep({ name: "review", intent: step.intent! })}>
                Try again
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  setAmount("");
                  setStep(merchant ? { name: "entry" } : { name: "loading" });
                }}
              >
                Start over
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <footer className="mt-auto pb-2 text-center text-xs text-muted-foreground">
        Gantry · gasless EIP-3009 · settles in XSGD (testnet mock) on Base Sepolia
      </footer>
    </main>
  );
}
