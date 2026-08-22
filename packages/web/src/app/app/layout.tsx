"use client";

import type { ReactNode } from "react";
import { PayerProvider } from "@/components/payer/payer-context";
import { PayerFrame } from "@/components/payer/payer-frame";

/**
 * The shell for all four tabs.
 *
 * It is a layout rather than something each page mounts so that switching tabs
 * keeps the store alive: the balance, the settlement page and the agent
 * enumeration are shared, and remounting them on every tap would refetch all
 * three. Two of those are backend round trips (the settlement page and the
 * agent enumeration, the latter costing four RPC calls behind it); the balance
 * is a direct RPC read from the browser. On a venue hotspot that is a visible
 * stall on every tab tap.
 *
 * No `entry`: these four routes are the app's own tabs, so there is no floor
 * overlay and an emptied overlay stack has somewhere to be — the tab underneath
 * it. The provider reads the rest from the URL itself, which is what makes
 * `/app/agents?agent=0x…` and the other overlay links survive a refresh.
 */
export default function PayerAppLayout({ children }: { children: ReactNode }) {
  return (
    <PayerProvider>
      <PayerFrame>{children}</PayerFrame>
    </PayerProvider>
  );
}
