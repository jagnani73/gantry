"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
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
 * stretching it across a 1440px laptop misrepresents the product to anyone
 * reviewing it there — which is every judge who opens the deployed link. The
 * mock is PRESENTATION ONLY: everything that draws it (the 402px width, the
 * bezel, the radius, the centring, the speaker slit) is behind `lg:`, so a
 * handset renders none of it. The unprefixed rules — `bg-paper`, the hidden
 * scrollbar, `relative`, `h-dvh` — are the app itself and apply everywhere.
 *
 * BELOW `lg` the frame fills the window and the CONTENT is what caps at
 * `max-w-md`, not the frame. That distinction is load-bearing for overlays: they
 * are `absolute` against this element, so a frame capped at 448px turned the
 * green success screen into a card floating on paper on a tablet or a
 * half-width desktop window. Capping the content instead keeps the column
 * phone-width and lets the tone reach the viewport edges, which is what the
 * screen is drawn to do.
 *
 * `relative` is load-bearing rather than cosmetic — see OverlayScreen, whose
 * overlays are positioned against this element so they cannot escape the mock.
 */
export function PayerFrame({ children }: { children: ReactNode }) {
  const { overlay } = usePayer();
  const mainRef = useRef<HTMLElement>(null);
  const pathname = usePathname();

  /**
   * Next resets the DOCUMENT scroll on navigation, and this app deliberately
   * does not scroll the document — the pane below does, and it lives in the
   * layout, so it survives a tab change with its offset intact. Without this,
   * tapping Agents from halfway down a long Activity list lands you halfway
   * down Agents.
   *
   * `instant` is not a stylistic choice: `main` is set to `scroll-behavior:
   * smooth` in globals.css, so the default would animate a scroll UP through
   * content the payer never asked to see. It also rules out the reverse bug of
   * setting `scrollTop` directly, which inherits the same smooth behaviour.
   *
   * Keyed on pathname alone. Overlays (pay, receipt, a shop page) are context
   * state at the same URL and scroll inside their own element, so closing one
   * returns the payer to where they were — which is what they expect.
   */
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname]);

  return (
    <div className="lg:flex lg:min-h-dvh lg:items-center lg:justify-center lg:bg-nav-active lg:py-10">
      {/* The design draws this at 874px tall, but a 768px-high laptop is common
          and a fixed height would push the tab bar off the bottom — so cap it
          against the viewport instead. `ring` rather than `border` for the
          bezel: a border is inside the box and would eat 16px of the 402px. */}
      <div className="scrollbar-hidden relative mx-auto flex h-dvh w-full flex-col overflow-hidden bg-paper lg:h-[min(874px,calc(100dvh-5rem))] lg:w-device lg:rounded-device lg:shadow-drawer lg:ring-8 lg:ring-ink">
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
          {/* The scroll is on <main> and the width cap is on the column inside
              it, so a wide window scrolls one full-height surface rather than a
              448px strip of one. The tab bar caps its own grid the same way. */}
          <main ref={mainRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-md px-5 pt-15.5 pb-6">{children}</div>
          </main>
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
