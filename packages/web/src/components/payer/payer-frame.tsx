"use client";

import type { ReactNode } from "react";
import { AgentDetail } from "./agent-detail";
import { AgentForm } from "./agent-form";
import { MerchantPage } from "./merchant-page";
import { PayFlow } from "./pay-flow";
import { Receipt } from "./receipt";
import { Scan } from "./scan";
import { TabBar } from "./tab-bar";
import { usePayer, type Overlay } from "./payer-context";

/**
 * The phone shell: one scrolling screen, the tab bar pinned under it, and a
 * full-screen overlay above both.
 *
 * `h-dvh` with the scroll on the inner pane rather than the document is what
 * keeps the tab bar in place on a phone — a page-level scroll drags it off the
 * bottom on the first flick. On a wide screen the column stays phone-width
 * instead of stretching, because this surface is drawn for a phone and there is
 * no desktop version of it.
 */
export function PayerFrame({ children }: { children: ReactNode }) {
  const { overlay } = usePayer();
  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col overflow-hidden">
      <main className="flex-1 overflow-y-auto px-5 pt-15.5 pb-6">{children}</main>
      <TabBar />
      <OverlayHost overlay={overlay} />
    </div>
  );
}

function OverlayHost({ overlay }: { overlay: Overlay | null }) {
  if (!overlay) return null;
  switch (overlay.kind) {
    case "scan":
      return <Scan />;
    // Keyed on the subject so opening a second shop or agent starts that
    // screen's own state fresh rather than inheriting the last one's.
    case "pay":
      return <PayFlow key={overlay.handle} handle={overlay.handle} />;
    case "receipt":
      return <Receipt key={overlay.row.key} row={overlay.row} />;
    case "merchant":
      return <MerchantPage key={overlay.handle} handle={overlay.handle} />;
    case "agent":
      return <AgentDetail key={overlay.wallet} wallet={overlay.wallet} />;
    case "agentForm":
      return <AgentForm key={overlay.wallet ?? "new"} wallet={overlay.wallet} />;
  }
}
