"use client";

import { cn } from "@/lib/utils";

/**
 * The one switch on this surface. A real `role="switch"` rather than a styled
 * div, because the state it carries — whether the counter makes a sound when
 * money arrives — is exactly the kind a screen reader has to be able to read.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "focus-ring flex w-11 shrink-0 rounded-full p-0.75 transition-colors",
        checked ? "justify-end bg-accent" : "justify-start bg-nav-active",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
    >
      <span aria-hidden className="size-5 rounded-full bg-surface" />
    </button>
  );
}
