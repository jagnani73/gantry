"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { erc20Abi, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  GANTRY_FEE_BPS,
  formatUnits6,
  parseSgd,
  quoteAmountIn,
  reviveTypedData,
  shortAddress,
  type IntentResponse,
  type SettlementEvent,
} from "@gantry/shared";
import { Card, Figure, Mono } from "@/components/primitives";
import { api, ApiClientError } from "@/lib/api";
import { getDemoAccount } from "@/lib/demo-account";
import { settlementKey, type ActivityRow } from "./activity";
import { AmountKeypad, isValidAmount } from "./amount-keypad";
import { formatRate } from "./format";
import { OverlayHeader, OverlayScreen } from "./overlay";
import { usePayer } from "./payer-context";

/**
 * The demo spine: scan → amount → review → paid.
 *
 * The state machine, the signing path and the funding step below are carried
 * over from the pay page this replaces rather than rewritten. Each was earned:
 * the double-tap guard exists because a phone fires two taps, the balance poll
 * exists because a mined transfer is not yet visible on a lagging RPC replica,
 * and the `IntentAlreadySettled` branch exists because rendering a settled
 * payment as a failure while the merchant's dashboard chimes is the worst split
 * this product can produce.
 */

type Step =
  | { name: "entry" }
  | { name: "quoting" }
  | { name: "review"; intent: IntentResponse }
  | { name: "preparing"; intent: IntentResponse }
  | { name: "funding"; intent: IntentResponse }
  | { name: "signing"; intent: IntentResponse }
  | { name: "settling"; intent: IntentResponse }
  | { name: "settled"; row: SettlementEvent; settleMs: number | null }
  | { name: "failed"; intent: IntentResponse | null; errorName: string; message: string };

/** One faucet grant is 4 real USDC ≈ S$5.37 and the page funds once before
 * signing, so the demo cap must sit under a single grant. */
const BURNER_MAX_SGD = 5;
const WALLET_MAX_SGD = 9999;

// Computed during render rather than seeded in an effect, so a fresh quote never
// paints a one-frame "expired" flash before the first tick lands.
function useCountdown(expiry: number | undefined): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!expiry) return;
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [expiry]);
  return expiry ? Math.max(0, expiry - now) : 0;
}

export function PayFlow({ handle }: { handle: string }) {
  const {
    identity,
    merchant,
    ensureMerchant,
    rate,
    chainNow,
    refreshHistory,
    refreshBalance,
    closeOverlays,
    replaceOverlay,
  } = usePayer();

  const [step, setStep] = useState<Step>({ name: "entry" });
  const [amount, setAmount] = useState("");

  const { address: walletAddress, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();

  const demo = identity.demo;
  const max = demo ? BURNER_MAX_SGD : WALLET_MAX_SGD;

  useEffect(() => {
    ensureMerchant(handle);
  }, [ensureMerchant, handle]);

  const record = merchant(handle);
  const title = record?.displayName ?? handle;

  const fail = useCallback(
    (intent: IntentResponse | null, payer: Address | null, err: unknown) => {
      // A settle that raced a retry (or a dropped response plus a retry) comes
      // back as 409 IntentAlreadySettled WITH the tx hash. That is a success.
      if (intent && payer && err instanceof ApiClientError && err.errorName === "IntentAlreadySettled") {
        const txHash = (err.args as { txHash?: Hex } | undefined)?.txHash;
        if (txHash) {
          setStep({ name: "settled", row: replayedRow(intent, payer, txHash), settleMs: null });
          return;
        }
      }
      setStep({
        name: "failed",
        intent,
        errorName: err instanceof ApiClientError ? err.errorName : "Error",
        message: err instanceof Error ? err.message : String(err),
      });
    },
    [],
  );

  const quote = useCallback(async () => {
    setStep({ name: "quoting" });
    try {
      const intent = await api.createIntent({
        handle,
        xsgdAmount: parseSgd(amount).toString(),
        token: "USDC",
      });
      setStep({ name: "review", intent });
    } catch (err) {
      fail(null, null, err);
    }
  }, [amount, handle, fail]);

  const requote = useCallback(
    async (old: IntentResponse) => {
      setStep({ name: "quoting" });
      try {
        setStep({ name: "review", intent: await api.requote(old.intentId) });
      } catch (err) {
        fail(old, null, err);
      }
    },
    [fail],
  );

  const confirmInFlight = useRef(false);

  const confirm = useCallback(
    async (intent: IntentResponse) => {
      if (confirmInFlight.current) return; // phone double-tap guard
      if (!demo && !walletAddress) return; // the connect button is shown instead
      confirmInFlight.current = true;
      // Hoisted so the IntentAlreadySettled branch can still name the payer —
      // that branch renders a receipt, and a receipt without a payer is a lie.
      let payer: Address | null = null;
      setStep({ name: "preparing", intent });
      try {
        let signature: Hex;

        if (demo) {
          const account = getDemoAccount();
          payer = account.address;
          if (publicClient) {
            const readBalance = () =>
              publicClient.readContract({
                address: intent.tokenIn,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [account.address],
              });
            if ((await readBalance()) < BigInt(intent.amountIn)) {
              setStep({ name: "funding", intent });
              await api.faucet(account.address);
              // The transfer is mined, but RPC replicas lag — wait until the
              // balance is actually visible before signing against it.
              for (let i = 0; (await readBalance()) < BigInt(intent.amountIn); i++) {
                if (i >= 10) throw new Error("funds not visible yet — try again");
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
        // Timed from here, not from the tap: the faucet top-up and the balance
        // poll before it are the demo funding the payer, not the rail settling.
        const startedAt = Date.now();
        const settled = await api.settle(intent.intentId, {
          payer,
          signature,
          validBefore: intent.validBefore,
        });
        setStep({
          name: "settled",
          row: {
            ...settledRow(intent, payer, settled.txHash, chainNow()),
            xsgdOut: settled.xsgdOut,
            feeXsgd: settled.feeXsgd,
            blockNumber: settled.blockNumber,
          },
          settleMs: Date.now() - startedAt,
        });
        // The feed and the balance are both stale the moment this lands.
        refreshHistory();
        refreshBalance();
      } catch (err) {
        fail(intent, payer, err);
      } finally {
        confirmInFlight.current = false;
      }
    },
    [
      demo,
      chainId,
      chainNow,
      fail,
      publicClient,
      refreshBalance,
      refreshHistory,
      signTypedDataAsync,
      switchChainAsync,
      walletAddress,
    ],
  );

  const countdown = useCountdown(step.name === "review" ? step.intent.expiry : undefined);
  const expired = step.name === "review" && countdown === 0;

  const busyLabel = useMemo(() => {
    switch (step.name) {
      case "quoting":
        return "Locking your rate…";
      case "preparing":
        return "Preparing payment…";
      case "funding":
        return "Funding your demo wallet…";
      case "signing":
        return "Waiting for your signature…";
      case "settling":
        return "Settling on Base Sepolia…";
      default:
        return null;
    }
  }, [step.name]);

  /* ── Success ─────────────────────────────────────────────────────────── */
  if (step.name === "settled") {
    const { row, settleMs } = step;
    return (
      <OverlayScreen tone="accent">
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-on-accent/14 text-title-lg">
            ✓
          </div>
          <Figure units={row.xsgdOut} size="paid" tone="on-accent" className="mt-6 justify-center" />
          <p className="mt-4 text-body-lg text-on-accent-body">Paid to {title}</p>
          <Mono size="xs" className="mt-1.5 text-on-accent-muted">
            {settleMs === null ? "" : `settled in ${(settleMs / 1000).toFixed(1)}s · `}
            {shortAddress(row.txHash)}
          </Mono>
        </div>
        <div className="flex shrink-0 flex-col gap-2.5 px-5 pb-11">
          <button
            type="button"
            onClick={() => replaceOverlay({ kind: "receipt", row: receiptRow(row) })}
            className="focus-ring-inverse h-13 rounded-control-m bg-on-accent text-btn-sm text-ink transition-colors hover:bg-paper"
          >
            View receipt
          </button>
          <button
            type="button"
            onClick={closeOverlays}
            className="focus-ring-inverse h-13 rounded-control-m bg-on-accent/12 text-btn-sm text-on-accent transition-colors hover:bg-on-accent/20"
          >
            Done
          </button>
        </div>
      </OverlayScreen>
    );
  }

  /* ── Failure ─────────────────────────────────────────────────────────── */
  if (step.name === "failed") {
    const { intent, errorName, message } = step;
    const stale = errorName === "IntentExpired" || errorName === "IntentWasCancelled";
    return (
      <OverlayScreen>
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-danger-tint text-title-lg text-danger">
            ✕
          </div>
          <h2 className="mt-5.5 text-title">Payment didn&apos;t go through</h2>
          <p className="mt-3 text-body text-muted">
            {stale
              ? "The rate you were quoted ran out before it settled. Nothing was charged — take a fresh rate and try again."
              : "Nothing left your wallet. The authorization is only good for this one payment, so it is safe to try again on a fresh quote."}
          </p>
          {/* The error name travels verbatim from the chain or the API; the
              sentence above explains it, never replaces it. */}
          <Mono size="xs" tone="faintest" className="mt-3.5">
            {errorName}
            {intent ? ` · ${shortAddress(intent.intentId)}` : ""}
          </Mono>
          <p className="mt-2 max-w-[34ch] text-fine text-faint">{message}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-2.5 px-5 pb-11">
          <button
            type="button"
            onClick={() => {
              if (intent) void requote(intent);
              else setStep({ name: "entry" });
            }}
            className="focus-ring h-13 rounded-control-m bg-ink text-btn-sm text-paper transition-colors hover:bg-ink-hover"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={closeOverlays}
            className="focus-ring h-13 rounded-control-m bg-surface text-btn-sm text-ink transition-colors hover:bg-fill-hover-card"
          >
            Back to wallet
          </button>
        </div>
      </OverlayScreen>
    );
  }

  /* ── Busy ────────────────────────────────────────────────────────────── */
  if (busyLabel) {
    const intent = "intent" in step ? step.intent : null;
    return (
      <OverlayScreen>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <div className="size-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-body text-muted">{busyLabel}</p>
          {intent ? <Figure units={intent.xsgdAmount} size="detail" /> : null}
        </div>
      </OverlayScreen>
    );
  }

  /* ── Review ──────────────────────────────────────────────────────────── */
  if (step.name === "review") {
    const { intent } = step;
    const canSign = demo || Boolean(walletAddress);
    return (
      <OverlayScreen>
        <OverlayHeader
          onBack={() => setStep({ name: "entry" })}
          backLabel="Back to the amount"
          title="Confirm payment"
        />
        <div className="flex flex-1 flex-col gap-3.5 px-5 pt-6.5">
          <Card tone="accent" radius="card-m" pad="md">
            <p className="text-label uppercase text-on-accent-muted">You&apos;re paying</p>
            <Figure units={intent.xsgdAmount} size="balance" tone="on-accent" className="mt-3" />
            <p className="mt-3.5 text-body-sm text-on-accent-body">{title}</p>
          </Card>

          <Card radius="card-m" pad="none" className="flex flex-col gap-3 px-5.5 py-5">
            <BreakdownRow label="You send">
              <Mono>
                {formatUnits6(BigInt(intent.amountIn), 6)} {intent.tokenSymbol}
              </Mono>
            </BreakdownRow>
            <BreakdownRow label="Shop receives">
              <Mono>{formatUnits6(BigInt(intent.xsgdAmount))} XSGD</Mono>
            </BreakdownRow>
            <BreakdownRow label="Rate">
              <Mono>1 USDC = {formatRate(BigInt(intent.rate))}</Mono>
            </BreakdownRow>
            <div className="flex items-baseline justify-between gap-3.5 border-t border-fill-subtle pt-3">
              <span className="text-body text-muted">Network fee</span>
              <span className="text-body font-medium text-accent">Paid for you</span>
            </div>
          </Card>

          {expired ? (
            <Card tone="danger" radius="control-m" pad="none" className="px-4.5 py-4">
              <p className="text-body font-semibold">This quote expired</p>
              <p className="mt-1.75 text-meta text-danger">
                Rates are locked for a few minutes so the shop knows exactly what it receives.
                Nothing was charged.
              </p>
            </Card>
          ) : (
            <div className="flex items-center gap-2.5 px-1">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              <span className="text-meta text-muted">
                Rate locked · expires in {Math.floor(countdown / 60)}:
                {String(countdown % 60).padStart(2, "0")}
              </span>
            </div>
          )}
        </div>

        <div className="shrink-0 px-5 pb-11">
          {expired ? (
            <button
              type="button"
              onClick={() => void requote(intent)}
              className="focus-ring h-13.5 w-full rounded-control-m bg-ink text-btn text-paper transition-colors hover:bg-ink-hover"
            >
              Get a fresh rate
            </button>
          ) : canSign ? (
            <>
              <button
                type="button"
                onClick={() => void confirm(intent)}
                className="focus-ring h-13.5 w-full rounded-control-m bg-ink text-btn text-paper transition-colors hover:bg-ink-hover"
              >
                Pay — one signature
              </button>
              <p className="mt-3 text-center text-fine text-faint">
                You sign once. Funds move only for this exact payment, and the gas is paid for you.
              </p>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2.5">
              <p className="text-meta text-muted">Connect a wallet to sign</p>
              <ConnectButton showBalance={false} />
            </div>
          )}
        </div>
      </OverlayScreen>
    );
  }

  /* ── Amount ──────────────────────────────────────────────────────────── */
  const valid = isValidAmount(amount, max);
  const overCap = amount !== "" && Number(amount) > max;
  // Computed, never stored: ceil(xsgd * 1e6 / rate), the same function the
  // backend quotes with — a floored quote can swap to less than the shop was
  // promised and revert InsufficientOutput on-chain. The review screen shows the
  // intent's own `amountIn` instead, because that is what the signature covers.
  const estimate = valid && rate ? formatUnits6(quoteAmountIn(parseSgd(amount), rate), 6) : null;

  return (
    <OverlayScreen>
      <OverlayHeader
        onBack={closeOverlays}
        backLabel="Cancel this payment"
        glyph="✕"
        title={title}
        subtitle={record?.location}
      />

      <div className="flex flex-1 flex-col items-center justify-center gap-1.5">
        {record === null ? (
          <p className="px-8 text-center text-body text-muted">
            No shop is registered at <Mono>{handle}</Mono> on Base Sepolia.
          </p>
        ) : (
          <>
            <Figure value={amount || "0"} size="entry" prefixTone="faint" />
            <p className="text-meta text-muted">
              {overCap
                ? `The demo wallet caps one payment at S$${max}`
                : estimate
                  ? `≈ ${estimate} USDC at the demo rate`
                  : valid
                    ? "Rate locks when you continue"
                    : "Enter an amount"}
            </p>
          </>
        )}
      </div>

      <AmountKeypad
        value={amount}
        onChange={setAmount}
        onSubmit={() => void quote()}
        max={max}
        disabled={record === null}
        submitLabel={valid ? `Pay S$${amount}` : "Pay"}
      />
      <div className="h-6.5 shrink-0" />
    </OverlayScreen>
  );
}

function BreakdownRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3.5">
      <span className="text-body text-muted">{label}</span>
      {children}
    </div>
  );
}

/**
 * The settlement the payer just made, as a feed row.
 *
 * Built locally rather than waited for: the indexer needs a second or two to see
 * the log, and a "View receipt" that spins is a worse answer than one showing
 * numbers we already hold. Everything here is real except `logIndex` — unknown
 * until the log is indexed, and it only feeds a row key that `txHash` already
 * makes unique — and `blockTime`, which is the chain's clock as this client last
 * read it.
 */
function settledRow(
  intent: IntentResponse,
  payer: Address,
  txHash: Hex,
  at: number,
): SettlementEvent {
  return {
    intentId: intent.intentId,
    merchantId: intent.merchantId,
    handle: intent.handle,
    payer,
    tokenIn: intent.tokenIn,
    tokenSymbol: intent.tokenSymbol,
    amountIn: intent.amountIn,
    xsgdOut: intent.xsgdAmount,
    feeXsgd: "0",
    door: intent.door,
    txHash,
    blockNumber: 0,
    logIndex: 0,
    blockTime: at,
  };
}

/**
 * The same row for a settle we did not observe — the 409 that carries a tx hash.
 *
 * The gross output and the fee did not come back with that error, so they are
 * reconstructed from what the contract is known to do: it swaps to at least the
 * quoted XSGD and skims `GANTRY_FEE_BPS`. Both are the floor of the truth rather
 * than a guess — a swap can overshoot the quote — and the alternative was
 * showing the shop receiving the gross, which is wrong by a definite amount
 * instead of an indefinite one.
 */
function replayedRow(intent: IntentResponse, payer: Address, txHash: Hex): SettlementEvent {
  const xsgdOut = BigInt(intent.xsgdAmount);
  return {
    ...settledRow(intent, payer, txHash, Math.floor(Date.now() / 1000)),
    feeXsgd: ((xsgdOut * BigInt(GANTRY_FEE_BPS)) / 10_000n).toString(),
  };
}

function receiptRow(row: SettlementEvent): ActivityRow {
  return {
    kind: "settlement",
    key: settlementKey(row),
    at: row.blockTime,
    handle: row.handle,
    settlement: row,
  };
}
