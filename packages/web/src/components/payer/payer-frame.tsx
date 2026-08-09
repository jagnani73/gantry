"use client";

import type { ReactNode } from "react";
import { ToastProvider } from "@/components/primitives";
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
 * bottom on the first flick.
 *
 * On a desktop viewport (`lg` and up) the shell sits inside a phone mock. This
 * surface is drawn for a phone and there is no desktop version of it, so
 * stretching it across 1400px misrepresents the product to anyone reviewing it
 * on a laptop — which is every judge who opens the deployed link. The mock is
 * PRESENTATION ONLY and must never reach a real phone: every device rule is
 * behind `lg:`, so a handset renders exactly what it rendered before.
 *
 * `relative` is load-bearing rather than cosmetic — see OverlayScreen, whose
 * overlays are positioned against this element so they cannot escape the mock.
 */
export function PayerFrame({ children }: { children: ReactNode }) {
  const { overlay } = usePayer();
  return (
    <div className="lg:flex lg:min-h-dvh lg:items-center lg:justify-center lg:bg-nav-active lg:py-10">
      {/* The design draws this at 874px tall, but a 768px-high laptop is common
          and a fixed height would push the tab bar off the bottom — so cap it
          against the viewport instead. `ring` rather than `border` for the
          bezel: a border is inside the box and would eat 16px of the 402px. */}
      <div className="scrollbar-hidden relative mx-auto flex h-dvh max-w-md flex-col overflow-hidden bg-paper lg:h-[min(874px,calc(100dvh-5rem))] lg:w-device lg:max-w-none lg:rounded-device lg:shadow-drawer lg:ring-8 lg:ring-ink">
        {/* Speaker slit. Sits in the 62px the content already reserves for a
            status bar, so it costs no layout. */}
        <span
          aria-hidden
          className="absolute top-4 left-1/2 hidden h-1.5 w-16 -translate-x-1/2 rounded-full bg-ink/15 lg:block"
        />
        {/* Inside the frame, not around it: the toast stack is positioned
            against the nearest positioned ancestor, and this element is it. A
            provider mounted at the layout would put toasts outside the phone
            mock on a desktop viewport. `pb-28` clears the tab bar. */}
        <ToastProvider viewportClassName="pb-28">
          <main className="flex-1 overflow-y-auto px-5 pt-15.5 pb-6">{children}</main>
          <TabBar />
          <OverlayHost overlay={overlay} />
        </ToastProvider>
      </div>
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
