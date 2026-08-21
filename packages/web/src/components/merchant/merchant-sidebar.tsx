"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CATEGORY_LABELS, shortAddress } from "@gantry/shared";
import { Card, GantryMark, Label, Mono, StatusDot } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { windowIsPartial } from "@gantry/shared";
import { feedStatusOf, rowsForOverviewWindow } from "./feed-state";
import { shopName, useMerchantContext } from "./merchant-context";
import { MERCHANT_SCREENS, SCREEN_LABEL, merchantHref, type MerchantScreen } from "./screens";
import { grouped } from "./format";
import { useNowSeconds } from "./use-now";

const STATUS_TEXT = {
  accent: "text-accent",
  warning: "text-warning",
  danger: "text-danger",
} as const;

/**
 * The 248px column. Below roughly 1100px it becomes a header strip with a
 * scrolling nav — the design is drawn at 1440 and the intermediate widths were
 * left unspecified, so the rule is simply that nothing becomes unreachable.
 *
 * It hides itself when printing: the QR screen prints its standee from inside
 * this shell, and a nav column is not part of what goes on a counter.
 */
export function MerchantSidebar() {
  const { handle, merchant, feed } = useMerchantContext();
  const pathname = usePathname();
  const now = useNowSeconds();

  const windowRows = rowsForOverviewWindow(feed.rows, now);
  const status = feedStatusOf(feed.connection);

  // Overview counts the rolling window, Transactions the whole book. Two counts,
  // because they answer different questions and a merchant reads both — but they
  // are not the same KIND of number, and the window change made that bite. The
  // Transactions figure is the server's total and exact; the Overview one counts
  // only the rows this browser has loaded, capped at one page. A seven-day window
  // can fill a page, and without the "+" the sidebar would then read a flat page
  // size beside an exact total on all five screens, with no way to tell it is
  // truncated. The Overview screen says so in a full sentence and offers "Load
  // older"; this badge has room for one character. Raising `PAGE_SIZE` to 100 put
  // the demo book inside one page, so the "+" no longer fires in a rehearsal —
  // which makes it MORE load-bearing, not less: it is now a case nobody sees
  // until a real shop trades past a page, and an unnoticed missing "+" reads as
  // an exact count.
  const windowPartial = windowIsPartial(windowRows.length, feed.rows.length, feed.hasMore);
  const count: Partial<Record<MerchantScreen, string>> = {
    overview:
      windowRows.length > 0 ? `${grouped(windowRows.length)}${windowPartial ? "+" : ""}` : "",
    transactions: feed.total > 0 ? grouped(feed.total) : "",
  };

  return (
    <aside className="flex flex-col gap-7.5 border-b border-hairline-strong px-6 py-8 min-[1100px]:border-r min-[1100px]:border-b-0 print:hidden">
      <div className="flex items-center gap-2.5">
        <GantryMark className="h-5.5" />
        <span className="text-card-title-sm">Gantry</span>
        <Label as="span" size="eyebrow-sm" tone="faint" className="ml-auto">
          Merchant
        </Label>
      </div>

      <Card radius="control-m" pad="sm">
        <div className="text-card-title">{shopName(merchant, handle)}</div>
        <Mono size="2xs" tone="muted" className="mt-1.5 block break-all">
          @{handle}
        </Mono>
        <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-hairline pt-3.5">
          <span className="text-meta-sm text-muted">
            {merchant === null
              ? "…"
              : (CATEGORY_LABELS[merchant.categoryId] ?? merchant.categoryName)}
          </span>
          <span
            className={cn("inline-flex items-center gap-1.5 text-meta-sm", STATUS_TEXT[status.tone])}
          >
            <StatusDot tone={status.tone} />
            {status.label}
          </span>
        </div>
      </Card>

      <nav
        aria-label="Merchant sections"
        className="-mx-1 flex gap-0.5 overflow-x-auto px-1 min-[1100px]:mx-0 min-[1100px]:flex-col min-[1100px]:overflow-visible min-[1100px]:px-0"
      >
        {MERCHANT_SCREENS.map((screen) => {
          const href = merchantHref(handle, screen);
          const active = pathname === href;
          return (
            <Link
              key={screen}
              href={href}
              aria-current={active ? "page" : undefined}
              // `text-list-title` bakes weight 500, which is the active state;
              // `font-normal` composes over it for the idle one.
              className={cn(
                "focus-ring text-list-title flex shrink-0 items-center justify-between gap-3 rounded-nav px-3.5 py-2.5 whitespace-nowrap transition-colors",
                active
                  ? "bg-nav-active text-ink"
                  : "font-normal text-quiet hover:bg-nav-hover hover:text-ink",
              )}
            >
              <span>{SCREEN_LABEL[screen]}</span>
              {count[screen] ? (
                <Mono size="2xs" tone="faint">
                  {count[screen]}
                </Mono>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-3.5 min-[1100px]:mt-auto">
        <p className="text-fine text-faint">
          Payouts settle instantly to
          <br />
          {merchant === null ? (
            "…"
          ) : (
            <Mono size="2xs" tone="quiet">
              {shortAddress(merchant.payout)}
            </Mono>
          )}
          <br />
          Base Sepolia · XSGD
        </p>
        <Link
          href="/"
          className="focus-ring w-fit rounded-badge text-fine text-faint hover:text-ink"
        >
          ← Overview
        </Link>
      </div>
    </aside>
  );
}
