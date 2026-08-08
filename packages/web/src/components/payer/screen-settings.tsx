"use client";

import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { BASE_SEPOLIA_ADDRESSES, basescanAddress, shortAddress } from "@gantry/shared";
import { Card, KeyValue, KeyValueList, Mono } from "@/components/primitives";
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
  const { identity, rate } = usePayer();

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

        {identity.demo ? (
          <>
            <p className="mt-3 text-meta text-muted">
              A shared demo account this build is configured with, funded for you. It is not
              yours and it is not private — everyone running this demo signs with the same key,
              so treat the payments and agents here as a public sandbox.
            </p>
            {/* Deliberately inert. Migrating this history onto a connected
                wallet is a real feature with a real design, and a button that
                silently swapped the signer mid-demo would be worse than none. */}
            <button
              type="button"
              disabled
              className="mt-4 h-12 w-full cursor-not-allowed rounded-tile bg-nav-active text-btn-sm font-medium text-faintest"
            >
              Connect my own wallet
            </button>
            <p className="mt-2 text-center text-fine text-faint">Coming soon</p>
          </>
        ) : (
          <div className="mt-4">
            <ConnectButton showBalance={false} />
          </div>
        )}
      </Card>

      <Card radius="card-m" pad="none" className="mt-3 px-5 py-2">
        <KeyValueList>
          <KeyValue label="Network">Base Sepolia</KeyValue>
          <KeyValue label="Display currency">SGD</KeyValue>
          <KeyValue label="Pay token">USDC</KeyValue>
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
        Payments settle in real Circle USDC on Base Sepolia — you sign an EIP-3009 authorization
        against Circle&apos;s own contract — and pay out in XSGD, which here is a testnet mock
        because XSGD exists on no testnet. The FX rate is set by the swap&apos;s owner, not sourced
        from a market.
      </p>
      <Link href="/" className="focus-ring mt-3.5 block rounded-badge px-1 text-fine text-faint">
        ← Overview
      </Link>
      <div className="h-3" />
    </>
  );
}
