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
 * three — the agent walk alone is a block-range scan.
 */
export default function PayerAppLayout({ children }: { children: ReactNode }) {
  return (
    <PayerProvider>
      <PayerFrame>{children}</PayerFrame>
    </PayerProvider>
  );
}
