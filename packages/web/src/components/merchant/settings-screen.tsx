"use client";

import {
  BASE_SEPOLIA_ADDRESSES,
  CATEGORY_LABELS,
  basescanAddress,
  shortAddress,
} from "@gantry/shared";
import { Card, Mono } from "@/components/primitives";
import { shortDate } from "./format";
import { useMerchantContext } from "./merchant-context";
import { ScreenHeader } from "./screen-header";
import { Toggle } from "./toggle";

/** Named for the shop, not for the variable — `mockXsgd` has to read as a mock
 * everywhere it appears, and `realUsdc` is deliberately absent: a merchant is
 * never paid in it. */
const CONTRACTS = [
  { name: "GantryCore", address: BASE_SEPOLIA_ADDRESSES.gantryCore },
  { name: "FixedRateSwap", address: BASE_SEPOLIA_ADDRESSES.fixedRateSwap },
  { name: "XSGD (testnet mock)", address: BASE_SEPOLIA_ADDRESSES.mockXsgd },
] as const;

export function SettingsScreen() {
  const { handle, merchant, chime } = useMerchantContext();

  const rows = [
    {
      label: "Payout address",
      help: "Where every payment lands, in XSGD. Changing it is an on-chain write only this address can sign.",
      value: merchant ? shortAddress(merchant.payout) : "…",
    },
    {
      label: "Handle",
      help: "Claimed once, permanently. It is the address your QR encodes.",
      value: `@${handle}`,
    },
    {
      label: "Category",
      help: "Read by agent spend policies. Self-attested: there is no KYC on this deployment.",
      value: merchant
        ? (CATEGORY_LABELS[merchant.categoryId] ?? merchant.categoryName)
        : "…",
    },
    {
      label: "Registered",
      help: "The block your merchant record was written to GantryCore.",
      // Absent when the log lookup did not resolve. An estimate would be worse
      // than saying so: this is the date a shop would cite as proof it existed.
      value: merchant?.registeredAt === undefined ? "Unknown" : shortDate(merchant.registeredAt),
    },
  ];

  return (
    <div className="flex max-w-180 flex-col gap-5">
      <ScreenHeader title="Settings">
        This account, and the parts of it that live on-chain.
      </ScreenHeader>

      <Card radius="card" pad="none" className="p-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-6 rounded-tile px-5 py-4.5 transition-colors hover:bg-fill-hover-card"
          >
            <div className="min-w-0">
              <div className="text-list-title">{row.label}</div>
              <p className="mt-1 text-meta text-muted">{row.help}</p>
            </div>
            <Mono size="md" tone="quiet" className="shrink-0">
              {row.value}
            </Mono>
          </div>
        ))}
      </Card>

      <Card radius="card" pad="none" className="px-6 py-5.5">
        <div className="text-list-title">Chime on new payment</div>
        <p className="mt-1.5 mb-3.5 text-meta text-muted">
          A short tone when a settlement lands. Browsers need one tap on the page before they will
          play sound, so it arms itself the first time you click anything.
        </p>
        <div className="flex items-center gap-3">
          <Toggle
            checked={chime.on}
            onChange={(next) => void chime.set(next)}
            label="Chime on new payment"
          />
          <span className="text-body text-quiet">
            {!chime.on ? "Off" : chime.armed ? "On" : "On · waiting for a tap"}
          </span>
        </div>
      </Card>

      <Card radius="card" pad="none" className="px-6 py-5.5">
        <div className="text-list-title">Contracts</div>
        <div className="mt-3 flex flex-col gap-2">
          {CONTRACTS.map((contract) => (
            <div key={contract.name} className="flex items-center justify-between gap-4">
              <Mono size="sm" tone="muted">
                {contract.name}
              </Mono>
              <a
                className="focus-ring rounded-badge"
                href={basescanAddress(contract.address)}
                target="_blank"
                rel="noreferrer"
              >
                <Mono size="sm">{shortAddress(contract.address)} ↗</Mono>
              </a>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
