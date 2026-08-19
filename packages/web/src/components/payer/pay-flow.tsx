"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { erc20Abi, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  basescanTx,
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
import { describeWriteError } from "@/lib/write-error";
import { getDemoAccount } from "@/lib/demo-account";
import { settlementKey, type ActivityRow } from "./activity";
import { AmountKeypad, isAmountShape, isValidAmount } from "./amount-keypad";
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
 *
 * There are THREE terminal states, not two, and the third is the load-bearing
 * one. The relayer caps `waitForTransactionReceipt` at 20s and rethrows; that
 * shape is deliberately not retried, so a settle whose transaction has been
 * BROADCAST comes back to this page as a 500. Calling that "failed" would print
 * a mined transaction's hash under the sentence "Nothing left your wallet"
 * while the merchant's dashboard chimes — the same compensation invariant the
 * bridge and the onboarding path already obey, applied to the QR spine.
 */

type Step =
  | { name: "entry" }
  | { name: "quoting" }
  | { name: "review"; intent: IntentResponse }
  | { name: "preparing"; intent: IntentResponse }
  | { name: "funding"; intent: IntentResponse }
  | { name: "signing"; intent: IntentResponse }
  | { name: "settling"; intent: IntentResponse }
  | {
      name: "settled";
      row: SettlementEvent;
      settleMs: number | null;
      /** The row was rebuilt from a 409 rather than observed, so its figures are
       * the quote, not the settlement. Nothing derived may be shown as fact. */
      reconstructed?: boolean;
    }
  /** Proven: nothing moved. This is the only state allowed to say so. */
  | { name: "failed"; intent: IntentResponse | null; errorName: string; message: string }
  /** Not proven either way. Never claims the funds are safe, never offers a
   * blind retry. `settled: true` narrows it to "it went through, we just cannot
   * name the transaction". */
  | {
      name: "unknown";
      intent: IntentResponse | null;
      errorName: string;
      message: string;
      txHash: Hex | null;
      settled: boolean;
    };

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

/**
 * True only when the error PROVES the payer's authorization was never used.
 *
 * Mirrors the backend's own `isDefiniteFailure`. Its error middleware gives a
 * NAME to exactly two classes: an `ApiError` raised before anything was
 * broadcast, and a decoded contract or token revert (the transaction executed
 * and reverted, so no state changed). Everything else falls through to a 500
 * `InternalError` — and the one that matters is the relayer's receipt cap,
 * which rethrows for a transaction that is already in the mempool. A transport
 * failure is the same ambiguity from the other side: the request may well have
 * arrived and settled, and only the reply was lost.
 */
function provesNothingMoved(err: unknown): boolean {
  if (!(err instanceof ApiClientError)) return false;
  // status 0 = fetch itself threw (drop, CORS, timeout). No reply is not an answer.
  if (err.status === 0) return false;
  // A 200 that was not JSON — a captive portal answered, not the backend.
  if (err.errorName === "BadResponse") return false;
  // The relayer words a mined-and-reverted transaction exactly this way, and it
  // is the one InternalError that is definite: the state was rolled back.
  if (err.errorName === "InternalError") return /reverted on-chain/.test(err.message);
  // The token says this authorization was already consumed, while our own
  // intent is still pending — so it was not consumed by this settle. Either an
  // earlier attempt of ours landed and the disposable cache lost the row, or the
  // raw signature was front-run straight to the token (the documented vector
  // that strands the funds in the core). Both moved the payer's USDC, so this is
  // the one contract revert that proves the opposite of what a revert usually
  // does.
  if (err.errorName === "AuthorizationAlreadyUsed") return false;
  if (err.errorName === "StringRevert" && /used or canceled/i.test(err.message)) return false;
  return true;
}

/**
 * viem's receipt-timeout message names the transaction it gave up on:
 * `Timed out while waiting for transaction with hash "0x…" to be confirmed.`
 *
 * That hash is the most useful thing we can hand a payer whose outcome we
 * cannot resolve, so it is lifted out — narrowly, from that exact shape, so an
 * intent id (also 32 bytes) in some other message can never be rendered as a
 * payment they can look up.
 */
function pendingTxHash(message: string): Hex | null {
  const match = /transaction with hash "(0x[0-9a-fA-F]{64})"/.exec(message);
  return match ? (match[1] as Hex) : null;
}

/**
 * @param askingPrice What the shop is charging, when the payer arrived through
 *   a merchant's charge link rather than the printed standee. Prefills the pad;
 *   it is not a lock, because the person holding the phone is the one paying
 *   and a price they cannot edit is a price they cannot dispute.
 */
export function PayFlow({ handle, askingPrice }: { handle: string; askingPrice?: string }) {
  const {
    identity,
    merchant,
    ensureMerchant,
    merchantError,
    retryMerchant,
    rate,
    chainNow,
    refreshHistory,
    refreshBalance,
    closeOverlays,
    replaceOverlay,
    sendToken,
  } = usePayer();

  const [step, setStep] = useState<Step>({ name: "entry" });
  // Shape-checked, never trusted: this value came off a URL anyone can edit, so
  // junk starts the pad empty rather than rendering `?sgd=<script>` as a price.
  const [amount, setAmount] = useState(
    askingPrice && isAmountShape(askingPrice) ? askingPrice : "",
  );

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
  // Set only when the LOOKUP failed. `record === null` is the registry saying
  // no such shop; this is us never having asked it successfully.
  const lookupFailed = merchantError(handle);

  /**
   * Whoever signed the authorization this flow is settling.
   *
   * Held in a ref because the RECOVERY path needs it: "Try again" calls
   * `requote`, and a requote of an intent that actually settled comes back as
   * 409 `IntentAlreadySettled`. Without a payer that branch cannot render a
   * receipt, so the screen fell through to "Nothing left your wallet" while
   * holding the string that proves the opposite. Deriving it from `identity`
   * instead would name the CURRENT account, which a connected wallet can change
   * between the failure and the retry.
   */
  const signedBy = useRef<Address | null>(null);

  const fail = useCallback(
    (
      intent: IntentResponse | null,
      payer: Address | null,
      err: unknown,
      /** The settle request left this browser. Only then can the outcome be
       * ambiguous — everything before it (quote, funding, signature) fails with
       * nothing signed or nothing submitted. */
      submitted = false,
    ) => {
      const errorName = err instanceof ApiClientError ? err.errorName : "Error";
      const message = err instanceof Error ? err.message : String(err);

      // A settle that raced a retry (or a dropped response plus a retry) comes
      // back as 409 IntentAlreadySettled. That is a success, not a failure.
      if (intent && errorName === "IntentAlreadySettled") {
        const txHash = (err instanceof ApiClientError ? err.args : undefined) as
          | { txHash?: Hex }
          | undefined;
        if (txHash?.txHash && payer) {
          setStep({
            name: "settled",
            row: replayedRow(intent, payer, txHash.txHash),
            settleMs: null,
            reconstructed: true,
          });
        } else {
          // Settled, but we cannot name the transaction or the signer. Still
          // not a failure: the failure screen would swear nothing was charged.
          setStep({
            name: "unknown",
            intent,
            errorName,
            message,
            txHash: txHash?.txHash ?? null,
            settled: true,
          });
        }
        refreshHistory();
        refreshBalance();
        return;
      }

      if (submitted && !provesNothingMoved(err)) {
        setStep({
          name: "unknown",
          intent,
          errorName,
          message,
          txHash: pendingTxHash(message),
          settled: false,
        });
        // The feed is the only place that can resolve this, so start it moving.
        refreshHistory();
        refreshBalance();
        return;
      }

      setStep({ name: "failed", intent, errorName, message });
    },
    [refreshBalance, refreshHistory],
  );

  const quote = useCallback(async () => {
    setStep({ name: "quoting" });
    try {
      const intent = await api.createIntent({
        handle,
        xsgdAmount: parseSgd(amount).toString(),
        // The payer's choice, not a constant. The backend quotes in this token
        // and returns the EIP-712 domain for it, so the signature below names
        // whichever of Circle's tokens they picked without a second branch.
        token: sendToken,
      });
      setStep({ name: "review", intent });
    } catch (err) {
      fail(null, null, err);
    }
  }, [amount, handle, fail, sendToken]);

  const requote = useCallback(
    async (old: IntentResponse) => {
      setStep({ name: "quoting" });
      try {
        setStep({ name: "review", intent: await api.requote(old.intentId) });
      } catch (err) {
        // The payer is the one who signed the OLD intent — a requote signs
        // nothing, so the only outcome this can resolve is that one's.
        fail(old, signedBy.current, err);
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
      // Flips the instant the settle request leaves this browser. Everything
      // before it is provably un-charged; everything after it may have landed.
      let submitted = false;
      setStep({ name: "preparing", intent });
      try {
        let signature: Hex;

        if (demo) {
          const account = getDemoAccount();
          payer = account.address;
          signedBy.current = payer;
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
              // The INTENT's token, not the payer's current preference: the
              // balance loop below reads `intent.tokenIn`, so funding anything
              // else grants a currency this payment cannot spend and then spins
              // out the ten retries against a balance that was never topped up.
              // The intent is also the pinned quote, so it stays right if the
              // preference changes while this screen is open.
              const granted = await api.faucet(account.address, intent.tokenSymbol);
              // The grant carries a second leg. A refused gas top-up changes
              // nothing here — the payer signs, the relayer sends — so it must
              // not interrupt a payment in progress; but it is the reason an
              // agent write fails minutes later, so it does not vanish either.
              // The screen that claims a top-up succeeded is the wallet screen,
              // and that one reports it.
              if (granted.gas?.error) {
                console.warn(
                  `gantry: gas leg of the faucet grant was refused (${granted.gas.error.name}: ${granted.gas.error.message}). The payment is unaffected; owner transactions may not be.`,
                );
              }
              // The transfer is mined, but RPC replicas lag — wait until the
              // balance is actually visible before signing against it.
              for (let i = 0; (await readBalance()) < BigInt(intent.amountIn); i++) {
                if (i >= 10) throw new Error("funds not visible yet: try again");
                await new Promise((resolve) => setTimeout(resolve, 1500));
              }
            }
          }
          setStep({ name: "signing", intent });
          signature = await account.signTypedData(reviveTypedData(intent.typedData, payer));
        } else {
          payer = walletAddress!;
          signedBy.current = payer;
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
        submitted = true;
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
        // The feed and the balance are both stale the moment this lands — and
        // the balance read issued right now is the one most likely to hit a
        // replica that has not seen the settling block, which is exactly what
        // `expectChange` re-reads for. Without it this called the poll's
        // motivating case and then skipped the poll.
        refreshHistory();
        refreshBalance({ expectChange: true });
      } catch (err) {
        fail(intent, payer, err, submitted);
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
    const { row, settleMs, reconstructed } = step;
    return (
      <OverlayScreen tone="accent">
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-on-accent/14 text-title-lg">
            ✓
          </div>
          <Figure units={row.xsgdOut} size="paid" tone="on-accent" className="mt-6 justify-center" />
          <p className="mt-4 text-body-lg text-on-accent-body">
            {reconstructed ? "Already paid to" : "Paid to"} {title}
          </p>
          <Mono size="xs" className="mt-1.5 text-on-accent-muted">
            {settleMs === null ? "" : `settled in ${(settleMs / 1000).toFixed(1)}s · `}
            {shortAddress(row.txHash)}
          </Mono>
          {/* This row was rebuilt from a 409, so the amount above is the QUOTE,
              not the settlement, and the fee, block and rate are not known at
              all. The receipt would render every one of them as fact, so it is
              not offered — the indexed row lands in Activity in a second or two
              and that one is real. */}
          {reconstructed ? (
            <p className="mt-5 max-w-[32ch] text-fine text-on-accent-muted">
              This payment had already settled when we asked again, so these are the figures you
              were quoted. The settled receipt appears in your activity once it is indexed.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-2.5 px-5 pb-11">
          {reconstructed ? (
            <a
              href={basescanTx(row.txHash)}
              target="_blank"
              rel="noreferrer"
              className="focus-ring-inverse flex h-13 items-center justify-center rounded-control-m bg-on-accent text-btn-sm text-ink transition-colors hover:bg-paper"
            >
              View on Basescan
            </a>
          ) : (
            <button
              type="button"
              onClick={() => replaceOverlay({ kind: "receipt", row: receiptRow(row) })}
              className="focus-ring-inverse h-13 rounded-control-m bg-on-accent text-btn-sm text-ink transition-colors hover:bg-paper"
            >
              View receipt
            </button>
          )}
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

  /* ── Unresolved ──────────────────────────────────────────────────────────
     The state that exists so the failure screen can keep its promise. Reached
     when the settle request left this browser and the answer did not come back
     in a shape that proves anything: a relayer receipt timeout (the transaction
     is broadcast and may still mine), a dropped connection, a captive portal.
     It must not say the funds are safe, and it must not offer a retry — a
     second signature on a fresh quote would pay the shop twice. */
  if (step.name === "unknown") {
    const { intent, errorName, message, txHash, settled } = step;
    return (
      <OverlayScreen>
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          {/* Neither the accent tick nor the danger cross: the whole point of
              this screen is that we do not know which one it is. */}
          <div className="flex size-16 items-center justify-center rounded-full bg-fill-subtle text-title-lg text-warning">
            ?
          </div>
          <h2 className="mt-5.5 text-title">
            {settled ? "This payment already went through" : "We couldn't confirm this payment"}
          </h2>
          <p className="mt-3 text-body text-muted">
            {settled
              ? "The rail says it settled, but it didn't hand back the transaction. Don't pay again: check your activity in a moment."
              : "Your authorization was submitted and we lost the answer, so it may or may not have settled. Don't pay again: check your activity in a moment, or ask the shop."}
          </p>
          {/* The error name travels verbatim, same as on the failure screen. */}
          <Mono size="xs" tone="faintest" className="mt-3.5">
            {errorName}
            {intent ? ` · ${shortAddress(intent.intentId)}` : ""}
          </Mono>
          {/* Shortened HERE, not in `fail`, because the raw message is
              load-bearing upstream: `pendingTxHash` pulls a transaction hash
              out of viem's receipt-timeout text with a regex, and a trimmed
              string would silently stop matching. The screen gets the
              sentence; the state keeps the whole thing, and the error NAME
              above it is verbatim either way. */}
          <p className="mt-2 max-w-[34ch] text-fine text-faint">
            {describeWriteError(new Error(message)).headline}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2.5 px-5 pb-11">
          {txHash ? (
            <a
              href={basescanTx(txHash)}
              target="_blank"
              rel="noreferrer"
              className="focus-ring flex h-13 items-center justify-center rounded-control-m bg-ink text-btn-sm text-paper transition-colors hover:bg-ink-hover"
            >
              Check {shortAddress(txHash)} on Basescan
            </a>
          ) : null}
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
              ? "The rate you were quoted ran out before it settled. Nothing was charged. Take a fresh rate and try again."
              : "Nothing left your wallet. The authorization is only good for this one payment, so it is safe to try again on a fresh quote."}
          </p>
          {/* The error name travels verbatim from the chain or the API; the
              sentence above explains it, never replaces it. */}
          <Mono size="xs" tone="faintest" className="mt-3.5">
            {errorName}
            {intent ? ` · ${shortAddress(intent.intentId)}` : ""}
          </Mono>
          {/* Shortened HERE, not in `fail`, because the raw message is
              load-bearing upstream: `pendingTxHash` pulls a transaction hash
              out of viem's receipt-timeout text with a regex, and a trimmed
              string would silently stop matching. The screen gets the
              sentence; the state keeps the whole thing, and the error NAME
              above it is verbatim either way. */}
          <p className="mt-2 max-w-[34ch] text-fine text-faint">
            {describeWriteError(new Error(message)).headline}
          </p>
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
            {/* Beside the price, never instead of it. The Singapore figure is
                what the shop charges and what it receives; this is a reading
                aid for a payer who does not think in dollars. */}
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
              {/* The intent's OWN token. `rate` is XSGD per 1e6 units of
                  `tokenIn`, so naming a fixed ticker here restated a euro
                  payment's rate as a dollar one on the screen the payer signs
                  from — and the correct symbol was already two rows up. */}
              <Mono>
                1 {intent.tokenSymbol} = {formatRate(BigInt(intent.rate))}
              </Mono>
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
                Pay with one signature
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
        {/* `null` is a chain fact — the registry has no such handle. A lookup
            that FAILED leaves `record` undefined and shows the pad anyway: the
            merchant id is resolved server-side when the intent is created, so a
            display lookup we could not reach is no reason to refuse a payment
            (and refusing it permanently, which is what caching the failure as
            "no such shop" used to do, is worse). */}
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
                  ? `≈ ${estimate} ${sendToken} at the demo rate`
                  : valid
                    ? "Rate locks when you continue"
                    : "Enter an amount"}
            </p>
            {/* Only once the amount parses — the keypad is mid-edit the rest of
                the time, and a reference figure that flickers per keystroke is
                noise rather than help. */}
            {lookupFailed ? (
              <p className="mt-3 max-w-[34ch] px-8 text-center text-fine text-faint">
                We couldn&apos;t look this shop up ({lookupFailed}).{" "}
                <button
                  type="button"
                  onClick={() => retryMerchant(handle)}
                  className="focus-ring rounded-badge text-accent underline-offset-2 hover:underline"
                >
                  Try again
                </button>
              </p>
            ) : null}
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
 *
 * The caller MUST overwrite `xsgdOut`, `feeXsgd` and `blockNumber` from the
 * settle response. The placeholders below are not the settlement, and the one
 * caller that cannot supply them (`replayedRow`) marks its row `reconstructed`
 * so no screen renders them as fact.
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
    // This payer signed the authorization themselves — the facilitator bridge is
    // the vanilla-x402 agent path and never this one.
    bridged: false,
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
 * Nothing here is derived, deliberately. The gross output, the fee and the block
 * did not come back with that error, and the previous version reconstructed them
 * from what the contract is known to do — which reads as settled fact on a
 * receipt while being the quote plus arithmetic. The caller marks this row
 * `reconstructed` and shows only `xsgdAmount` (what the payer agreed to) and the
 * transaction hash (which the error stated); the real figures arrive with the
 * indexed row a second or two later.
 */
function replayedRow(intent: IntentResponse, payer: Address, txHash: Hex): SettlementEvent {
  return settledRow(intent, payer, txHash, Math.floor(Date.now() / 1000));
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
