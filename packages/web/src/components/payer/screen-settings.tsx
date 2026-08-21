"use client";

import { useState } from "react";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  BASE_SEPOLIA_ADDRESSES,
  basescanAddress,
  settlementSendToken,
  shortAddress,
} from "@gantry/shared";
import { Card, KeyValue, KeyValueList, Mono } from "@/components/primitives";
import { switchSigner, type SignerPreference } from "@/lib/payer-signer";
import { CurrencyPicker } from "./currency-picker";
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
  const { identity, rate, rateError, payCurrency, payCurrencyReady, sendToken } = usePayer();
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
        {/* Reserved the same way as the block below, and for the same measured
            reason. "Looking for your wallet…" is one short line; the address
            that replaces it is 42 mono characters, which wraps to TWO lines
            below about a 395px viewport. That swap moved everything under it by
            17.5px on a phone and −1.25px on a desktop — the whole residual once
            the block below stopped moving.

            The spacer is an address-SHAPED string rather than a height: same
            length, same font, so it wraps exactly as the real one will at any
            width. A fixed height cannot, which is the lesson from the first
            attempt at the block below. */}
        <div className="relative mt-3">
          {identity.address ? (
            <Mono size="md" tone="quiet" breakAll className="block">
              {identity.address}
            </Mono>
          ) : identity.ready ? (
            <p className="text-body-sm text-muted">No wallet connected yet.</p>
          ) : (
            <>
              <Mono size="md" tone="quiet" breakAll aria-hidden inert className="invisible block">
                0x0000000000000000000000000000000000000000
              </Mono>
              <p className="absolute inset-x-0 top-0 text-body-sm text-muted">
                Looking for your wallet…
              </p>
            </>
          )}
        </div>

        {/* Gated on `ready`, like every other payer screen. The stored signer
            preference resolves in an effect, so `demo` is false on the first
            committed render — and without this gate a demo build painted the
            connected branch (a Connect button plus "Go back to the demo
            account") for one frame, with a layout shift, on the one screen
            whose job is to state which account signs.

            That gate fixed one shift and caused another: rendering NOTHING
            while unready, then swapping in the resolved block, pushed
            everything below it down — including the currency picker, which is
            the control deciding which token the payer signs for, so a tap
            aimed at it landed elsewhere.

            The space is therefore reserved by rendering the REAL block,
            invisibly. A `min-height` was tried first and is the wrong
            mechanism: the block's height depends on how the shared-account
            paragraph wraps, so one number cannot be right at two widths.
            Measured, 9.5rem left 49px of jump on a desktop frame and 87px at
            375px — worst on a phone, which is exactly where the mis-tap it
            exists to prevent happens. An invisible copy wraps identically at
            every width by construction, and cannot drift from the visible one
            because it is the same component. */}
        <div className="relative">
          {identity.ready ? (
            identity.demo ? (
              <DemoAccount onSwitch={() => void choose("connected")} />
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
            )
          ) : (
            <>
              {/* `invisible`, not `hidden`: it must still take up space. Inert
                  to a screen reader and to the tab order, so the only thing a
                  payer perceives is the line below it. */}
              <div aria-hidden className="invisible" inert>
                <DemoAccount onSwitch={() => undefined} />
              </div>
              <p className="absolute inset-x-0 top-3 text-meta text-faint">
                Checking which account signs…
              </p>
            </>
          )}
        </div>
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
        <div className="mt-3.5">
          <CurrencyPicker />
        </div>
        <p className="mt-3.5 text-fine text-faint">
          {/* Names the real contract, because that is the claim: a payer signing
              in euros is authorising Circle's own EURC, not a Gantry mock.

              Gated on `payCurrencyReady` for the same reason the picker above
              is. `payCurrency` starts at USD on both sides of hydration and the
              stored choice arrives in an effect, so a euro payer's first frame
              read "You sign an authorization for USDC" — in words, beside a
              picker deliberately showing NO selection. The two halves of one
              card disagreeing is a worse frame than the jump F6 removed, on the
              one screen whose whole job is to say which token signs. */}
          {payCurrencyReady ? (
            <>
              You sign for {settlementSendToken(payCurrency)}, Circle&apos;s own token. The swap
              converts it to XSGD at the owner-set rate.
            </>
          ) : (
            <>Checking which token you sign for…</>
          )}
        </p>
      </Card>

      <Card radius="card-m" pad="none" className="mt-3 px-5 py-2">
        <KeyValueList>
          <KeyValue label="Network">Base Sepolia</KeyValue>
          {/* Same gate: this states the token in the fewest possible words, so
              stating the wrong one is that much easier to read as fact. */}
          <KeyValue label="You pay in">
            {payCurrencyReady ? (
              sendToken
            ) : (
              <span className="inline-block h-3 w-12 animate-pulse rounded-badge bg-fill-hover align-middle" />
            )}
          </KeyValue>
          <KeyValue label="Shop is paid in">
            <span className="inline-flex items-center gap-2">
              XSGD
              <Mono size="2xs" tone="faint">
                fixed
              </Mono>
            </span>
          </KeyValue>
          <KeyValue label="Rate">
            {/* THREE answers, not two. The rate is read per-token and the read
                is stamped with the token it answered for, so switching currency
                makes this null until the new one lands — and "unavailable" over
                that gap is a claim about the swap that is not true. It also has
                to be distinguishable from the previous behaviour, which was
                worse than either: the OLD token's rate sat here relabelled, so
                picking euros read `1 EURC = 1.3421 XSGD`.

                The row above flips instantly (it is local state) and this one
                waits a round-trip, which is what the placeholder is for. */}
            {rate ? (
              `1 ${sendToken} = ${formatRate(rate)} XSGD`
            ) : rateError ? (
              "unavailable"
            ) : (
              <span className="inline-block h-3.5 w-32 animate-pulse rounded-badge bg-fill-hover align-middle" />
            )}
          </KeyValue>
          <KeyValue label="Receipts">On-chain</KeyValue>
          <KeyValue label="Settlement" divider={false}>
            <a
              className="focus-ring rounded-badge underline-offset-2 hover:underline"
              href={basescanAddress(BASE_SEPOLIA_ADDRESSES.gantryCore)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(BASE_SEPOLIA_ADDRESSES.gantryCore)} <span aria-hidden>↗</span>
            </a>
          </KeyValue>
        </KeyValueList>
      </Card>

      <p className="mt-5 px-1 text-fine text-faint">
        USDC and EURC are real Circle tokens on Base Sepolia. XSGD here is a testnet mock, because
        XSGD exists on no testnet, and the rate is set by the swap&apos;s owner rather than by a
        market.
      </p>
      <Link href="/" className="focus-ring mt-3.5 block rounded-badge px-1 text-fine text-faint">
        ← Overview
      </Link>
      <div className="h-3" />
    </>
  );
}

/**
 * The shared-demo-account block, extracted for ONE reason: the loading state
 * renders it invisibly to reserve its exact height, and a copy-pasted spacer
 * would drift from it the first time this copy changed.
 *
 * The button it carries used to be inert and said "Coming soon". What made the
 * switch hard was never the switch — it was the assumption that history had to
 * come with it. It does not, and it must not: an activity feed is every
 * settlement whose on-chain payer is this address, and an agent is a wallet
 * this address owns on-chain. Neither is ours to move, and claiming to move
 * them would mean showing one account's payments under another's name.
 *
 * So the switch is exactly a switch, and nothing migrates. The copy no longer
 * spells that out: it is a shared sandbox account, which the line above says,
 * and a paragraph nobody reads is not a disclosure. `switchSigner` reloads,
 * which is what stops two screens from holding different answers to "who am I".
 */
function DemoAccount({ onSwitch }: { onSwitch: () => void }) {
  return (
    <>
      <p className="mt-3 text-meta text-muted">
        A funded, public demo account is plugged in. Everyone here signs with the same key.
      </p>
      <button
        type="button"
        onClick={onSwitch}
        className="focus-ring mt-4 h-12 w-full rounded-tile bg-ink text-btn-sm font-medium text-paper transition-colors hover:bg-ink-hover"
      >
        Use my own wallet instead
      </button>
    </>
  );
}
