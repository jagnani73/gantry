"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Transient confirmation, for actions whose result has nowhere to live.
 *
 * The app's default is inline feedback and it should stay that way: the profile
 * editor prints "Saved." beside its own button, a failed payment renders a card
 * where the payment was. Reach for a toast only where inline is impossible —
 * the action closes the surface that would have shown it (Revoke), or leaves no
 * slot beside it (Copy pay link), or its effect lands somewhere the eye is not
 * (a balance refreshing at the top of a scrolled screen).
 *
 * NOT a substitute for state. A toast is unreadable to anyone who looked away,
 * so nothing may be announced ONLY here: a balance still updates, an error still
 * renders where the action was. This layer is confirmation, never the record.
 */

export type ToastTone = "success" | "danger";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  success(message: string): void;
  /** Errors also belong somewhere permanent — see the note above. */
  error(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Success is a confirmation you may miss; an error is one you must not. */
const DISMISS_MS: Record<ToastTone, number> = { success: 4_000, danger: 7_000 };

/** Older toasts drop off the top rather than growing a wall over the screen —
 * this surface is 402px wide and the tab bar is under it. */
const MAX_VISIBLE = 3;

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside a <ToastProvider>");
  return api;
}

export function ToastProvider({
  children,
  /** Positions the stack. The payer app pushes it clear of the tab bar; the
   * merchant surface has nothing at the bottom to avoid. */
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
};

/**
 * `absolute`, not `fixed`, and positioned against the nearest positioned
 * ancestor. On a desktop viewport the payer app renders inside a phone mock, and
 * a fixed viewport-anchored toast would appear outside the phone it belongs to.
 * Every mounting surface therefore has to be `relative` — PayerFrame already is,
 * for the same reason its overlays are.
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
