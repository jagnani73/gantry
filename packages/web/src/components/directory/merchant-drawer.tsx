"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import {
  BASE_SEPOLIA_CHAIN_ID,
  CATEGORY_LABELS,
  basescanBlock,
  type MerchantSummary,
} from "@gantry/shared";
import { Card, Chip, KeyValue, KeyValueList, Label, Mono } from "@/components/primitives";
import { ShopTile } from "@/components/merchant/shop-tile";
import { grouped, shortDate } from "@/components/merchant/format";

/** Everything inside the panel that a Tab should be able to reach. */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * One merchant's public record, opened from its card.
 *
 * The same drawer idiom the merchant back-office uses for a settlement, and
 * deliberately so — one detail pattern, not two. It goes further on two counts
 * the back-office does not, because this page is public and keyboard-first: it
 * TRAPS focus while open and RESTORES it to the card that opened it, so a
 * keyboard user is not dropped at the top of the document every time they look
 * at a shop and come back.
 *
 * **The privacy rule, and it is the reason this list is short.** The drawer
 * shows the public record — identity, category, location, registration — and
 * never volume, balance, payout address or transaction history. A shop's
 * takings are not public information; its identity is. The payout address is
 * public ON-CHAIN, which is not the same as belonging on a page that lists every
 * shop: `setMerchantPayout` is gated on that address, so it is the one field
 * whose exposure here would serve nobody the chain does not already serve.
 */
export function MerchantDrawer({
  merchant,
  onClose,
}: {
  merchant: MerchantSummary | null;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = merchant !== null;

  useEffect(() => {
    if (!open) return;
    // Captured before focus moves, so it is the card and not the close button.
    // That holds because this effect runs ONCE per open: `onClose` is a stable
    // callback on the parent. An inline arrow there would re-run this on every
    // parent render and re-capture the close button as the opener.
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;
      // Also catches focus that is OUTSIDE the panel entirely — a click on the
      // scrim leaves it on <body>, and without this arm the next Tab would walk
      // into the page behind a modal that is still covering it.
      const inside = panel.contains(document.activeElement);
      if (event.shiftKey && (!inside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    // The page behind is a long grid; letting it scroll under the panel makes
    // the scrim feel like a bug.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      // The grid does not re-render while the drawer is open, so this node is
      // still the card that was clicked.
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (merchant === null) return null;

  const name = merchant.displayName ?? merchant.handle;
  const category = CATEGORY_LABELS[merchant.categoryId] ?? merchant.categoryName;

  return (
    <div className="fixed inset-0 z-40">
      {/*
       * A real button, so click-outside is an affordance rather than a handler on
       * a div. Transparent below `md` because the sheet is nearly full height
       * there and a scrim over the remaining strip reads as a bug — but it stays
       * in the tree, because tapping above the sheet must still close it.
       */}
      <button
        type="button"
        aria-label={`Close ${name}`}
        onClick={onClose}
        className="absolute inset-0 animate-overlay-in cursor-pointer md:bg-ink/28"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${name}: merchant record`}
        className={
          // Bottom sheet under 768, right-hand drawer from there up. One
          // component: a 468px panel over a 390px viewport is not a narrower
          // drawer, it is a different thing, but it is not a second component.
          "absolute inset-x-0 bottom-0 flex h-[92vh] animate-sheet-in flex-col rounded-t-hero bg-surface " +
          "md:inset-y-0 md:right-0 md:left-auto md:h-auto md:w-full md:max-w-[468px] " +
          "md:animate-drawer-in md:rounded-none md:shadow-drawer"
        }
      >
        <div className="flex items-start justify-between gap-4 border-b border-fill-subtle px-7 pt-6.5 pb-5.5">
          <div className="flex min-w-0 items-center gap-4">
            <ShopTile name={merchant.displayName ?? ""} size="xl" />
            <div className="min-w-0">
              <div className="text-title-sm">{name}</div>
              <Mono size="xs" tone="faint" truncate className="mt-1.25">
                @{merchant.handle}
              </Mono>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-control bg-fill-subtle text-quiet transition-colors hover:bg-fill-hover-strong md:size-8"
          >
            {/* A back chevron on the sheet, a close cross on the drawer — the
                same control, named for the gesture it undoes at that size. */}
            <span className="md:hidden">‹</span>
            <span className="hidden md:inline">✕</span>
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-auto px-7 pt-5.5 pb-10">
          <div className="flex flex-wrap gap-1.5">
            <Chip tone="accent">{category}</Chip>
            {/* NEUTRAL, and the word is "Registered". Claiming a handle is
                permissionless and nothing here reviews a merchant, so a green
                chip saying "Verified" — which is what the design file drew —
                would be the page asserting exactly what its footer disclaims. */}
            <Chip>Registered on-chain</Chip>
          </div>

          {merchant.blurb ? <p className="text-body text-quiet">{merchant.blurb}</p> : null}

          {merchant.location ? (
            <Card tone="fill" radius="tile" pad="none" className="px-4.5 py-4">
              <div className="text-meta font-medium">Where to find it</div>
              <p className="mt-2 text-body-sm text-quiet">{merchant.location}</p>
            </Card>
          ) : null}

          <div>
            <Label size="lg">On-chain record</Label>
            <KeyValueList className="mt-2.5">
              <KeyValue label="Handle">{merchant.handle}</KeyValue>
              <KeyValue label="Merchant ID">{merchant.merchantId}</KeyValue>
              <KeyValue label="Category" mono={false}>
                {category}
              </KeyValue>
              <KeyValue label="Registered">{shortDate(merchant.registeredAt)}</KeyValue>
              <KeyValue label="Block">
                <a
                  className="focus-ring rounded-badge"
                  href={basescanBlock(merchant.blockNumber)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {grouped(merchant.blockNumber)} ↗
                </a>
              </KeyValue>
              <KeyValue label="Settles in" divider={false}>
                XSGD
              </KeyValue>
            </KeyValueList>
          </div>

          <Card tone="fill" radius="tile" pad="none" className="px-4.5 py-4">
            <div className="text-meta font-medium">Both doors, one handle</div>
            <p className="mt-2 text-meta text-muted">
              A person scans this shop&apos;s printed code; an agent requests the same handle over
              x402. Either way the shop receives XSGD, on Base Sepolia · eip155:
              {BASE_SEPOLIA_CHAIN_ID}.
            </p>
          </Card>

          {/*
           * The way out, and the reason the drawer exists rather than a tooltip.
           * This page listed every shop on the rail and offered no way to pay
           * one — a directory whose entries cannot be acted on is a phone book
           * with the numbers removed. Both destinations are public payer
           * surfaces, so linking them keeps the standing rule that this page
           * never leads into an authenticated screen.
           *
           * `/pay/…` is the primary because it is what the printed QR opens: the
           * point of finding a shop here is paying it, and the amount screen is
           * where that starts. `/m/…` is the same shop's page for someone who
           * wanted to look rather than to buy.
           */}
          <div className="flex flex-col gap-2.5">
            <Link
              href={`/pay/${merchant.handle}`}
              className="focus-ring flex h-12.5 items-center justify-center rounded-control-m bg-ink text-btn-sm font-medium text-paper transition-colors hover:bg-ink-hover"
            >
              Pay this shop
            </Link>
            <Link
              href={`/m/${merchant.handle}`}
              className="focus-ring flex h-12.5 items-center justify-center rounded-control-m bg-fill-subtle text-btn-sm font-medium text-ink transition-colors hover:bg-fill-hover-strong"
            >
              Open its shop page
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
