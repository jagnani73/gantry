"use client";

import { useState } from "react";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  BASE_SEPOLIA_ADDRESSES,
  DISPLAY_CURRENCIES,
  DISPLAY_CURRENCY_CODES,
  basescanAddress,
  settlementSendToken,
  shortAddress,
} from "@gantry/shared";
import { Card, KeyValue, KeyValueList, Mono } from "@/components/primitives";
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
  const { identity, rate, displayCurrency, setDisplayCurrency } = usePayer();
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
          Every price in the app switches to this.
        </p>
        <div className="mt-3.5 flex flex-wrap gap-2">
          {DISPLAY_CURRENCY_CODES.map((code) => {
            const option = DISPLAY_CURRENCIES[code];
            const active = option.code === displayCurrency.code;
            /* Each option carries its own state, because they are genuinely
               different things and a row of identical buttons would imply they
               are not. USD is the one you can actually send; SGD is the shop's
               own price; the rest restate a price you still pay in USDC. */
            const status = option.settleable
              ? "live"
              : option.source.kind === "settlement"
                ? "shop price"
                : "preview";
            return (
              <button
                key={code}
                type="button"
                aria-pressed={active}
                onClick={() => setDisplayCurrency(code)}
                className={cn(
                  "focus-ring flex h-13 min-w-22 flex-col items-start justify-center rounded-control px-3.5 transition-colors",
                  active
                    ? "bg-ink text-paper"
                    : "bg-fill-subtle text-muted hover:bg-fill-hover hover:text-ink",
                )}
              >
                <span className="text-btn-sm font-medium">
                  {option.symbol} {code}
                </span>
                <span className={cn("text-fine", active ? "text-paper/70" : "text-faint")}>
                  {status}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-3.5 text-fine text-faint">
          {/* The one sentence that has to survive any rewrite of this card: a
              preview currency changes the reading and not the payment. */}
          {displayCurrency.settleable ? (
            <>You send {settlementSendToken(displayCurrency)} — the rate is the on-chain swap rate.</>
          ) : displayCurrency.source.kind === "settlement" ? (
            <>Singapore dollars is what the shop charges and receives.</>
          ) : (
            <>
              Paying in {displayCurrency.label.toLowerCase()} is{" "}
              <strong className="font-medium text-muted">coming soon</strong>. Prices show in{" "}
              {displayCurrency.code} at an indicative rate; you still send{" "}
              {settlementSendToken(displayCurrency)} today.
            </>
          )}
        </p>
      </Card>

      <Card radius="card-m" pad="none" className="mt-3 px-5 py-2">
        <KeyValueList>
          <KeyValue label="Network">Base Sepolia</KeyValue>
          <KeyValue label="You pay in">USDC</KeyValue>
          <KeyValue label="Shop is paid in">
            <span className="inline-flex items-center gap-2">
              XSGD
              <Mono size="2xs" tone="faint">
                fixed
              </Mono>
            </span>
          </KeyValue>
          <KeyValue label="Rate">{rate ? `1 USDC = ${formatRate(rate)}` : "unavailable"}</KeyValue>
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
        Payments settle in real Circle USDC on Base Sepolia: you sign an EIP-3009 authorization
        against Circle&apos;s own contract. The payout is in XSGD, which here is a testnet mock
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
