"use client";

import { useEffect, useRef, useState } from "react";
import { DISPLAY_CURRENCIES, SEND_CURRENCY_OPTIONS, settlementSendToken } from "@gantry/shared";
import { useToast } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { usePayer } from "./payer-context";

/**
 * The one control that decides which token a payer signs for.
 *
 * ONE component, used by the settings card and by the wallet's popover, because
 * this app has been bitten by two surfaces that were meant to stay in step and
 * did not — a comment in two files saying "keep these in step" is not a
 * mechanism. Whatever the picker learns next (a fourth currency, a different
 * locked reason) it learns once.
 *
 * A SEGMENTED control rather than tiles: the per-option sub-label it used to
 * carry ("sends USDC") restated the sentence printed directly beneath the card,
 * and "coming soon" was the entire content of the locked option's toast. With
 * both gone the three options fit one row at 360px instead of wrapping.
 *
 * Locked options stay in the row and stay focusable. `aria-disabled`, never
 * `disabled`: a disabled control tells a screen reader nothing about WHY, and
 * why is the whole message. INR is visible on purpose — "any currency in" is the
 * claim, and a reader deserves to see what is not true yet rather than a list
 * quietly implying the set is closed.
 */
export function CurrencyPicker({
  tone = "paper",
  onSelect,
}: {
  tone?: "paper" | "accent";
  /** Called only when a PAYABLE option is chosen, so a popover can close on a
   * real selection and stay open on a locked one — the toast that answers a
   * locked tap is worth reading with the row still on screen. */
  onSelect?: () => void;
}) {
  const { payCurrency, setPayCurrency, payCurrencyReady } = usePayer();
  const toast = useToast();

  return (
    <div
      role="group"
      aria-label="Currency you pay in"
      className={cn(
        "flex w-full overflow-hidden rounded-control",
        tone === "accent" ? "bg-on-accent/14" : "bg-fill-subtle",
      )}
    >
      {SEND_CURRENCY_OPTIONS.map(({ code, locked }) => {
        const option = DISPLAY_CURRENCIES[code];
        /* Never active until the stored preference has been read. The value
           starts at USD on both sides of hydration and the real choice arrives
           in an effect, so painting a selection before `payCurrencyReady` made
           a euro payer's screen jump USD → EUR on every load. An unresolved
           picker shows no selection rather than the wrong one — the same rule
           the signer block on the settings screen already follows. */
        const active = payCurrencyReady && !locked && code === payCurrency.code;
        return (
          <button
            key={code}
            type="button"
            aria-pressed={active}
            aria-disabled={locked}
            onClick={() => {
              if (locked) {
                toast.info(`Paying in ${option.label} is coming soon.`);
                return;
              }
              setPayCurrency(code);
              onSelect?.();
            }}
            className={cn(
              "focus-ring flex h-11 flex-1 items-center justify-center gap-1.5 text-btn-sm font-medium transition-colors",
              locked
                ? "cursor-not-allowed"
                : active
                  ? tone === "accent"
                    ? "bg-on-accent text-accent"
                    : "bg-ink text-paper"
                  : "",
              !active &&
                (tone === "accent"
                  ? locked
                    ? "text-on-accent-muted/60"
                    : "text-on-accent-muted hover:text-on-accent"
                  : locked
                    ? "text-faint"
                    : "text-muted hover:text-ink"),
            )}
          >
            <span aria-hidden>{option.symbol}</span>
            {code}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The wallet card's currency control: a pill that opens the picker in place.
 *
 * INLINE rather than a full overlay, which is what this was first built as and
 * was the wrong weight — a whole screen to choose between three options, most of
 * which was the explanatory sentence the settings card already carries.
 *
 * It does NOT keep the balance visible; on a 390px frame a panel holding three
 * segments covers most of the card, and claiming otherwise was the first version
 * of this comment. What it keeps is the CONTEXT: no navigation, nothing pushed
 * off screen, and the figure is back the instant a choice is made — against an
 * overlay that replaced the screen and had to be dismissed to see the result of
 * the thing it just did.
 *
 * Absolutely positioned, so opening it moves NOTHING. That matters here more
 * than usual: this app has just been through two bugs where a control shifted
 * under a payer's finger, and the thing directly below this one is the figure
 * they are about to spend.
 *
 * The pill states the choice and does not cycle it. A cycling pill would change
 * which token a payer signs for on a stray tap, with no chance to see the
 * options first — on the one screen whose job is to say what they are spending.
 */
export function CurrencyPill() {
  const { payCurrency, payCurrencyReady } = usePayer();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // `pointerdown` in the CAPTURE phase, not `click`: the popover is gone
    // before any click handler runs, so it cannot be re-opened by a control
    // re-rendering under the finger.
    //
    // It does NOT stop that control activating, and an earlier version of this
    // comment claimed it did. Nothing here calls `preventDefault` and there is
    // no backdrop, so a dismissing tap on the tab bar or the Scan button both
    // closes this and does the thing it landed on. Left that way deliberately —
    // the alternative is a full-frame backdrop, and the reachable outside taps
    // are all navigations rather than anything that spends.
    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Focus follows the disclosure, or a keyboard payer opens a panel and is left
  // standing outside it with the next Tab going to the Top up button.
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        onClick={() => (open ? close(true) : setOpen(true))}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          payCurrencyReady
            ? `Currency you pay in: ${payCurrency.code}. Change it.`
            : "Currency you pay in, still loading"
        }
        className="focus-ring-inverse -my-1 flex items-center gap-1.5 rounded-badge bg-on-accent/14 px-2.5 py-1 text-meta font-medium text-on-accent transition-colors hover:bg-on-accent/22"
      >
        {/* The pill may not state a currency it does not yet know — the same
            rule the segments follow, and for the same reason: the stored
            preference arrives in an effect, so anything rendered before it is
            a guess. The placeholder is sized like a code so the pill does not
            resize when the real one lands. */}
        {payCurrencyReady ? (
          <>
            <span aria-hidden>{payCurrency.symbol}</span>
            {payCurrency.code}
          </>
        ) : (
          <span
            aria-hidden
            className="my-0.5 inline-block h-3 w-11 animate-pulse rounded-badge bg-on-accent/25"
          />
        )}
        <span aria-hidden className="text-on-accent-muted">
          ▾
        </span>
      </button>

      {open ? (
        <div
          ref={panel}
          tabIndex={-1}
          role="dialog"
          aria-label="Currency you pay in"
          /* Right-aligned and below: the pill sits at the card's right edge, so
             a left-aligned panel would hang off the frame on a phone.

             `w-72` overhangs the card's left edge onto the paper, which is
             deliberate — the segments read better with room, and a popover is
             allowed to be wider than the thing that opened it. The clamp is
             what keeps that safe: `right-0` anchors to the card's inner right
             edge, which sits 44px from the viewport's (20px column padding plus
             24px card padding), so an unclamped 288px panel runs off the left
             of a 360px phone. `calc(100vw-3.5rem)` leaves a 12px gutter at any
             width.

             Depth from FILL and a hairline, never a shadow — `--shadow-drawer`
             is documented as the only shadow in the system and this is not it.
             White on the accent card is already a hard edge; the border is what
             separates it from the paper it overhangs.

             `overlay-in` (a fade) rather than `overlay-push`, which translates
             100% from the right because it is the full-screen phone push. A
             popover that slides in from off-frame would be lying about where it
             came from. */
          className="animate-overlay-in absolute top-full right-0 z-40 mt-2 w-72 max-w-[calc(100vw-3.5rem)] rounded-card-m border border-hairline-strong bg-surface p-4 outline-none"
        >
          <CurrencyPicker onSelect={() => close(true)} />
          <p className="mt-2.5 text-fine text-faint">
            You sign for {settlementSendToken(payCurrency)}, Circle&apos;s own token. The shop is
            paid in XSGD either way.
          </p>
        </div>
      ) : null}
    </div>
  );
}
