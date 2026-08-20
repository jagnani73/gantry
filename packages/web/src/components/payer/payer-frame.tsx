"use client";

import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ToastProvider, useToast } from "@/components/primitives";
import { AgentDetail } from "./agent-detail";
import { AgentForm } from "./agent-form";
import { MerchantPage } from "./merchant-page";
import { PayFlow } from "./pay-flow";
import { PendingReceipt, Receipt } from "./receipt";
import { Scan } from "./scan";
import { TabBar } from "./tab-bar";
import { usePayer, type Overlay, type PayerStore } from "./payer-context";

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
  const { overlay, pendingReceipt } = usePayer();
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
   * Keyed on pathname alone, and that is now LOAD-BEARING rather than merely
   * sufficient. Overlays write their own query (`overlay-url.ts`) but never
   * change the pathname, so this does not fire when one opens and the pane keeps
   * its offset — closing an overlay returns the payer to where they were, which
   * is what they expect. Do NOT "correct" this to `useSearchParams` or to
   * `pathname + search`: that reinstates a scroll reset on every overlay open.
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
          <OverlayHost overlay={overlay} pendingReceipt={pendingReceipt} />
          <RefusedLinkToast />
        </ToastProvider>
      </div>
    </div>
  );
}

/**
 * The return type is ANNOTATED, and that is the enforcement — not decoration.
 *
 * `overlayToQuery` already fails to compile when a new `Overlay` member has no
 * URL spelling, because its return type is written out and its switch has no
 * `default`. This switch had neither, so a new kind returned `undefined`, which
 * React's `ReactNode` accepts happily: the overlay would push onto the stack,
 * write its query, and render NOTHING — a payer looking at the wallet screen
 * with a URL naming a screen that is not there, and a Back button that appears
 * dead. Annotating it makes the missing case TS2366, the same error the
 * serializer already relies on.
 *
 * Do not add a `default:` to either switch. The missing case is the point.
 */
function OverlayHost({
  overlay,
  pendingReceipt,
}: {
  overlay: Overlay | null;
  pendingReceipt: PayerStore["pendingReceipt"];
}): ReactElement | null {
  // Mutually exclusive by construction — a pending receipt only exists while the
  // stack is empty, and every mutator clears it — so the order here is a
  // tiebreak that should never be needed. The stack wins if one ever is: a real
  // overlay is something the payer opened, and a placeholder must not cover it.
  if (!overlay) {
    return pendingReceipt ? <PendingReceipt receipt={pendingReceipt} /> : null;
  }
  switch (overlay.kind) {
    case "scan":
      return <Scan />;
    // Keyed on the subject so opening a second shop or agent starts that
    // screen's own state fresh rather than inheriting the last one's.
    case "pay":
      return <PayFlow key={overlay.handle} handle={overlay.handle} askingPrice={overlay.amount} />;
    case "receipt":
      return <Receipt key={overlay.row.key} row={overlay.row} />;
    case "merchant":
      return <MerchantPage key={overlay.handle} handle={overlay.handle} />;
    case "agent":
      return <AgentDetail key={overlay.wallet} wallet={overlay.wallet} />;
    case "agentForm":
      return (
        <AgentForm
          key={overlay.wallet ?? "new"}
          wallet={overlay.wallet}
          addCategory={overlay.addCategory}
        />
      );
  }
}

/**
 * Says out loud that a link was refused.
 *
 * Renders nothing; it exists to be INSIDE `ToastProvider`. The provider that
 * detects the refusal is mounted outside it — the toast stack positions against
 * the phone frame, so it cannot be hoisted — and passing a callback down would
 * make the provider depend on a UI concern it has no other reason to know about.
 *
 * The flag is cleared as it is read, so the toast fires once per load rather
 * than on every re-render of the frame.
 */
function RefusedLinkToast() {
  const { linkRefused, clearLinkRefused } = usePayer();
  const toast = useToast();
  useEffect(() => {
    if (!linkRefused) return;
    clearLinkRefused();
    // Not "invalid link": the payer did not write it and cannot fix it. What is
    // useful is that the app is not simply ignoring them, and what to do next.
    toast.info("That link couldn't be opened. Scan the shop's code, or search for it.");
  }, [linkRefused, clearLinkRefused, toast]);
  return null;
}
