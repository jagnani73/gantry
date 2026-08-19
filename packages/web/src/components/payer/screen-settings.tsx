"use client";

import { useState } from "react";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  BASE_SEPOLIA_ADDRESSES,
  DISPLAY_CURRENCIES,
  SEND_CURRENCY_OPTIONS,
  basescanAddress,
  settlementSendToken,
  shortAddress,
} from "@gantry/shared";
import { Card, KeyValue, KeyValueList, Mono, useToast } from "@/components/primitives";
import { switchSigner, type SignerPreference } from "@/lib/payer-signer";
import { cn } from "@/lib/utils";
import { formatRate } from "./format";
import { usePayer } from "./payer-context";

/**
 * What this wallet is, and what it is settling in.
 *
 * The honest-labels footnote is not decoration: payments really do move Circle's
 * testnet USDC, and the shop really is paid in a mock XSGD, because XSGD exists
 * on no testnet at all. Both facts belong on the screen that explains the wallet.
 */
export function SettingsScreen() {
  const { identity, rate, payCurrency, setPayCurrency, sendToken } = usePayer();
  const toast = useToast();
  /** `switchSigner` throws only when storage is blocked, in which case the
   * reload never happens and this is the only thing that would say so. */
  const [switchError, setSwitchError] = useState<string | null>(null);

  const choose = (preference: SignerPreference) => {
    setSwitchError(null);
    try {
      switchSigner(preference);
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <h1 className="text-screen-title">Settings</h1>

      <Card radius="card-m" pad="m" className="mt-4.5">
        <div className="text-card-title-xs">This wallet</div>
        {identity.address ? (
          <Mono size="md" tone="quiet" breakAll className="mt-3 block">
            {identity.address}
          </Mono>
        ) : (
          <p className="mt-3 text-body-sm text-muted">
            {identity.ready ? "No wallet connected yet." : "Looking for your wallet…"}
          </p>
        )}

        {/* Gated on `ready`, like every other payer screen. The stored signer
            preference resolves in an effect, so `demo` is false on the first
            committed render — and without this gate a demo build painted the
            connected branch (a Connect button plus "Go back to the demo
            account") for one frame, with a layout shift, on the one screen
            whose job is to state which account signs. */}
        {!identity.ready ? null : identity.demo ? (
          <>
            <p className="mt-3 text-meta text-muted">
              A shared demo account this build is configured with, funded for you. It is not
              yours and it is not private: everyone running this demo signs with the same key,
              so treat the payments and agents here as a public sandbox.
            </p>
            {/*
             * The button that used to sit here was inert and said "Coming soon".
             * What made it hard was never the switch — it was the assumption
             * that history had to come with it. It does not, and it must not: an
             * activity feed is every settlement whose on-chain payer is this
             * address, and an agent is a wallet this address owns on-chain.
             * Neither is ours to move, and claiming to move them would mean
             * showing one account's payments under another's name.
             *
             * So the switch is exactly a switch, and the copy says what stays
             * behind. `switchSigner` reloads, which is what stops two screens
             * from holding different answers to "who am I".
             */}
            <button
              type="button"
              onClick={() => void choose("connected")}
              className="focus-ring mt-4 h-12 w-full rounded-tile bg-ink text-btn-sm font-medium text-paper transition-colors hover:bg-ink-hover"
            >
              Use my own wallet instead
            </button>
            <p className="mt-2 text-center text-fine text-faint">
              The demo account&apos;s payments and agents stay with the demo account: they belong
              to its address on-chain, not to this app. You can switch back here.
            </p>
          </>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <ConnectButton showBalance={false} />
            {identity.demoConfigured ? (
              <button
                type="button"
                onClick={() => void choose("demo")}
                className="focus-ring h-11 w-full rounded-tile bg-fill-hover text-btn-sm font-medium text-ink transition-colors hover:bg-fill-hover-strong"
              >
                Go back to the demo account
              </button>
            ) : null}
          </div>
        )}
        {switchError ? (
          <p className="mt-3 text-meta text-danger break-words">{switchError}</p>
        ) : null}
      </Card>

      <Card radius="card-m" pad="m" className="mt-3">
        <div className="text-card-title-xs">Currency you pay in</div>
        <p className="mt-2 text-fine text-faint">
          Changes the token you sign for and the balance below. The shop is paid in Singapore
          dollars either way.
        </p>
        <div className="mt-3.5 flex flex-wrap gap-2">
          {SEND_CURRENCY_OPTIONS.map(({ code, locked }) => {
            const option = DISPLAY_CURRENCIES[code];
            const active = !locked && code === payCurrency.code;
            return (
              <button
                key={code}
                type="button"
                aria-pressed={active}
                // Locked options stay in the tab order and announce themselves
                // rather than being `disabled`: a disabled control tells a
                // screen reader nothing about WHY, and "coming soon" is the
                // whole message. The toast is the answer to the tap.
                aria-disabled={locked}
                onClick={() =>
                  locked
                    ? toast.info(`Paying in ${option.label} is coming soon.`)
                    : setPayCurrency(code)
                }
                className={cn(
                  "focus-ring flex h-13 min-w-22 flex-col items-start justify-center rounded-control px-3.5 transition-colors",
                  locked
                    ? "cursor-not-allowed bg-fill-subtle text-faint"
                    : active
                      ? "bg-ink text-paper"
                      : "bg-fill-subtle text-muted hover:bg-fill-hover hover:text-ink",
                )}
              >
                <span className="text-btn-sm font-medium">
                  {option.symbol} {code}
                </span>
                <span className={cn("text-fine", active ? "text-paper/70" : "text-faint")}>
                  {locked ? "coming soon" : `sends ${settlementSendToken(option)}`}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-3.5 text-fine text-faint">
          {/* Names the real contract, because that is the claim: a payer signing
              in euros is authorising Circle's own EURC, not a Gantry mock. */}
          You sign an authorization for {settlementSendToken(payCurrency)} — Circle&apos;s own
          token — and the swap converts it to XSGD inside the settlement transaction, at the
          owner-set rate.
        </p>
      </Card>

      <Card radius="card-m" pad="none" className="mt-3 px-5 py-2">
        <KeyValueList>
          <KeyValue label="Network">Base Sepolia</KeyValue>
          <KeyValue label="You pay in">{sendToken}</KeyValue>
          <KeyValue label="Shop is paid in">
            <span className="inline-flex items-center gap-2">
              XSGD
              <Mono size="2xs" tone="faint">
                fixed
              </Mono>
            </span>
          </KeyValue>
          <KeyValue label="Rate">
            {rate ? `1 ${sendToken} = ${formatRate(rate)} XSGD` : "unavailable"}
          </KeyValue>
          <KeyValue label="Receipts">On-chain</KeyValue>
          <KeyValue label="Settlement" divider={false}>
            <a
              className="focus-ring rounded-badge underline-offset-2 hover:underline"
              href={basescanAddress(BASE_SEPOLIA_ADDRESSES.gantryCore)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(BASE_SEPOLIA_ADDRESSES.gantryCore)}
            </a>
          </KeyValue>
        </KeyValueList>
      </Card>

      <p className="mt-5 px-1 text-fine text-faint">
        Payments settle in real Circle stablecoins on Base Sepolia — USDC or EURC, whichever you
        chose — and you sign an EIP-3009 authorization against Circle&apos;s own contract either
        way. Neither is a mock. The payout is in XSGD, which here is a testnet mock
        because XSGD exists on no testnet. The FX rate is set by the swap&apos;s owner, not sourced
        from a market. The shop&apos;s currency is marked fixed rather than unbuilt: the settlement
        token is immutable on the contract, so it cannot differ by shop, by payer or by screen.
      </p>
      <Link href="/" className="focus-ring mt-3.5 block rounded-badge px-1 text-fine text-faint">
        ← Overview
      </Link>
      <div className="h-3" />
    </>
  );
}
