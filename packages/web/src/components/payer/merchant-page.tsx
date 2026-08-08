"use client";

import { useEffect, useMemo } from "react";
import { formatUnits6 } from "@gantry/shared";
import { Card, Chip, Mono } from "@/components/primitives";
import { placesPaid } from "./activity";
import { categoryLabels } from "./agent-rules";
import { calendarDate } from "./format";
import { MerchantTile } from "./merchant-tile";
import { OverlayHeader, OverlayScreen } from "./overlay";
import { usePayer } from "./payer-context";

/**
 * A shop, as the payer sees it.
 *
 * Reached from a receipt or from "Places you've paid" — there is no merchant
 * directory to browse, so a payer can only open a shop they have actually paid.
 * It carries nothing about the shop's balance or payouts; that lives behind the
 * merchant surface and never crosses over.
 */
export function MerchantPage({ handle }: { handle: string }) {
  const { merchant, ensureMerchant, rows, popOverlay, pushOverlay } = usePayer();

  useEffect(() => {
    ensureMerchant(handle);
  }, [ensureMerchant, handle]);

  const record = merchant(handle);
  const title = record?.displayName ?? handle;
  const history = useMemo(
    () => placesPaid(rows).find((place) => place.handle === handle),
    [rows, handle],
  );

  return (
    <OverlayScreen>
      <OverlayHeader onBack={popOverlay} backLabel="Back" title="Merchant" />
      <div className="flex flex-col gap-3.5 px-5 pt-6 pb-11">
        <Card radius="card-m" pad="md">
          <div className="flex items-center gap-3.5">
            <MerchantTile name={title} size="xl" />
            <div className="min-w-0">
              <div className="truncate text-card-title-m">{title}</div>
              {record?.location ? (
                <div className="mt-0.75 truncate text-meta text-muted">{record.location}</div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-1.5">
            {record ? <Chip tone="accent">{categoryLabels([record.categoryName])}</Chip> : null}
            {/* "Registered", not "verified": claiming a handle on GantryCore is
                permissionless and the category is self-attested. There is no KYC
                anywhere in this product and the chip must not imply one. */}
            <Chip>Registered on-chain</Chip>
          </div>

          {record?.blurb ? (
            <p className="mt-4 border-t border-fill-subtle pt-4 text-body-sm text-quiet">
              {record.blurb}
            </p>
          ) : null}

          <Mono size="3xs" tone="faintest" className="mt-3.5 block">
            @{handle}
            {record?.registeredAt ? ` · registered ${calendarDate(record.registeredAt)}` : ""}
          </Mono>
        </Card>

        {history ? (
          <Card radius="card-m" pad="none" className="px-5.5 py-5">
            <div className="text-card-title-xs">You&apos;ve paid here</div>
            <div className="mt-3.5 flex gap-7">
              <Stat label="Times" value={String(history.payments)} />
              <Stat label="Total" value={`S$${formatUnits6(history.total)}`} />
              <Stat label="First visit" value={calendarDate(history.firstAt)} />
            </div>
          </Card>
        ) : null}

        <button
          type="button"
          onClick={() => pushOverlay({ kind: "pay", handle })}
          className="focus-ring h-13.5 rounded-control-m bg-ink text-btn-sm text-paper transition-colors hover:bg-ink-hover"
        >
          {history ? "Pay again" : "Pay this shop"}
        </button>
      </div>
    </OverlayScreen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-fine text-faint">{label}</div>
      <Mono size="md" className="mt-1 block text-stat">
        {value}
      </Mono>
    </div>
  );
}
