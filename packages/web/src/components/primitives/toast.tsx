"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Transient confirmation, for actions whose result has nowhere to live.
 *
 * The app's default is inline feedback and it should stay that way: the QR
 * screen's Copy button relabels itself, a failed payment takes over the pay
 * flow's own screen. Reach for a toast only where the result lands somewhere the
 * eye is not — which, for a SUCCESS, is more often than it first looks, because
 * a form that succeeded usually resets and disables the control the merchant was
 * looking at.
 *
 * Callers today: the payer's wallet top-up (its effect is a balance at the top
 * of a screen usually scrolled down, and the granted amount appears nowhere
 * else), the payer's agent writes, and the merchant's shop-profile save. That
 * last one used to print "Saved." above its own Save button and is cited in
 * older comments as the model for inline feedback — it isn't any more.
 *
 * NOT a substitute for state, and the asymmetry is the rule: a toast is
 * unreadable to anyone who looked away, so SUCCESS may be transient while a
 * FAILURE must still render where the action was. Nothing may be announced only
 * here — a balance still updates, a profile still shows what was stored.
 *
 * Mounting: the viewport is `absolute` (see ToastViewport), so every surface
 * providing this must give it a positioned ancestor. `PayerFrame` and
 * `MerchantShell`'s content column both do.
 */

export type ToastTone = "success" | "danger" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  success(message: string): void;
  /** Errors also belong somewhere permanent — see the note above. */
  error(message: string): void;
  /**
   * Neither a success nor a failure: the answer to an action that was
   * understood and cannot be taken yet — a locked option explaining itself.
   *
   * Deliberately its own tone rather than borrowing one. `success` would claim
   * something happened and `error` would paint an ordinary tap red, and both
   * are the kind of small dishonesty this app avoids elsewhere.
   */
  info(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Success is a confirmation you may miss; an error is one you must not. */
const DISMISS_MS: Record<ToastTone, number> = { success: 4_000, danger: 7_000, info: 4_000 };

/** Older toasts drop off the top rather than growing a wall over the screen.
 * Sized for the narrowest mount: the payer app is 402px wide with a tab bar
 * under it, so three is already most of what fits. */
const MAX_VISIBLE = 3;

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside a <ToastProvider>");
  return api;
}

export function ToastProvider({
  children,
  /** Positions the stack. The payer app pushes it clear of its tab bar; the
   * merchant shell has no tab bar and needs no offset, but does mark it
   * `print:hidden` — the standee prints from that column. Both mounts had to
   * give the provider a positioned ancestor first, since the viewport is
   * `absolute` (see ToastViewport). */
  viewportClassName,
}: {
  children: ReactNode;
  viewportClassName?: string;
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  // Cleared on unmount so a timer cannot fire into a torn-down tree.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, tone, message }].slice(-MAX_VISIBLE));
    const timer = setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
      timers.current.delete(timer);
    }, DISMISS_MS[tone]);
    timers.current.add(timer);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push("success", message),
      error: (message) => push("danger", message),
      info: (message) => push("info", message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport
        items={items}
        className={viewportClassName}
        onDismiss={(id) => setItems((p) => p.filter((i) => i.id !== id))}
      />
    </ToastContext.Provider>
  );
}

const TONE: Record<ToastTone, string> = {
  success: "bg-ink text-paper",
  danger: "bg-danger text-paper",
  // Quieter than both: it is telling, not confirming or warning.
  info: "bg-fill-hover-strong text-ink",
};

/**
 * `absolute` by DEFAULT, against the nearest positioned ancestor: on a desktop
 * viewport the payer app renders inside a phone mock, and a viewport-anchored
 * toast would appear outside the phone it belongs to. That mount must therefore
 * be `relative` — PayerFrame already is, for the same reason its overlays are.
 *
 * A mount whose column SCROLLS THE DOCUMENT must override this to `fixed` via
 * `viewportClassName` (`cn` is tailwind-merge, so the later position wins). The
 * default only works where the positioned ancestor is height-capped and
 * scroll-contained, as PayerFrame's `h-dvh overflow-hidden` is; anchor it to a
 * stretched, uncapped column and `bottom-0` means the bottom of the page, which
 * on any screen taller than the viewport is a confirmation nobody sees. The
 * merchant shell hits exactly that and passes `fixed`.
 */
function ToastViewport({
  items,
  onDismiss,
  className,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div
      // `pointer-events-none` on the stack so a toast never blocks the control
      // that produced it; each toast re-enables its own so it stays dismissable.
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 p-4",
        className,
      )}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onDismiss(item.id)}
          // polite for a confirmation, assertive for a failure: a screen reader
          // should not have a success announcement interrupt what it is reading,
          // and should not have to wait to hear that something went wrong.
          role={item.tone === "danger" ? "alert" : "status"}
          aria-live={item.tone === "danger" ? "assertive" : "polite"}
          className={cn(
            "animate-overlay-push focus-ring-inverse pointer-events-auto max-w-full rounded-control-m px-4 py-3 text-left text-meta shadow-drawer",
            TONE[item.tone],
          )}
        >
          {item.message}
        </button>
      ))}
    </div>
  );
}
