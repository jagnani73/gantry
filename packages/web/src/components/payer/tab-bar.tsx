"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/primitives";
import { usePayer } from "./payer-context";

/**
 * Wallet · Activity · Agents · Settings.
 *
 * Real routes rather than client state so a tab is linkable and survives a
 * reload — and because they share a layout, switching between them keeps the
 * store mounted and costs no refetch. The design's glyphs are squares and dots
 * on purpose; this product has no icon set and is not getting one.
 */
const TABS = [
  { href: "/app", label: "Wallet" },
  { href: "/app/activity", label: "Activity" },
  { href: "/app/agents", label: "Agents" },
  { href: "/app/settings", label: "Settings" },
] as const;

export function TabBar() {
  const pathname = usePathname();
  const { closeOverlays } = usePayer();

  // `/pay/…` and `/m/…` render the wallet screen behind their overlay, so they
  // read as Wallet rather than leaving every tab dark.
  const active =
    TABS.slice(1).find((tab) => pathname.startsWith(tab.href))?.href ?? "/app";

  return (
    <nav className="shrink-0 border-t border-hairline-strong bg-paper/94 backdrop-blur-md">
      <div className="mx-auto grid max-w-md grid-cols-4 gap-1 px-3 pt-2.5 pb-7.5">
        {TABS.map((tab) => {
          const isActive = tab.href === active;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              /* Only a tap that does NOT change the pathname closes an overlay from here — note the test is `pathname`, not `isActive`: on `/pay/:handle` Wallet renders active and still navigates.
                 A tap that changes route is a navigation, and the provider
                 closes the stack when the pathname lands — closing it here as
                 well raced that navigation and cancelled it, because the URL
                 write-back then fired with the pathname the router was in the
                 middle of leaving. This branch is the case that navigation does
                 NOT cover: same route, so no pathname change, so nothing else
                 would ever dismiss what is on top. */
              onClick={() => {
                if (tab.href === pathname) closeOverlays();
              }}
              aria-current={isActive ? "page" : undefined}
              className="focus-ring flex flex-col items-center gap-1.25 rounded-nav py-1.5"
            >
              <span
                aria-hidden
                className={cn(
                  "size-4.5 rounded-chip-sm transition-colors",
                  isActive ? "bg-accent" : "bg-tab-idle",
                )}
              />
              <span className={cn("text-tab", isActive ? "text-ink" : "text-faint")}>
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
