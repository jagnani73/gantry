import * as React from "react";
import { cn } from "./cn";

/**
 * The label / value pair every detail view is built from — the merchant drawer,
 * the payer receipt, agent detail, settings.
 *
 * The value defaults to mono because in practice it is always a hash, an address,
 * a time or an amount. Pass `mono={false}` for the rare prose value ("Paid for
 * you"), so the exception is visible at the call site rather than assumed.
 */
export interface KeyValueProps extends Omit<React.ComponentProps<"div">, "children"> {
  label: React.ReactNode;
  children: React.ReactNode;
  mono?: boolean;
  divider?: boolean;
}

export function KeyValue({
  label,
  children,
  mono = true,
  divider = true,
  className,
  ...props
}: KeyValueProps) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-5 py-2.75",
        divider && "border-b border-paper",
        className,
      )}
      {...props}
    >
      <span className="text-key shrink-0 text-muted">{label}</span>
      <span
        className={cn(
          "text-right break-all",
          mono ? "text-mono font-mono tabular-nums" : "text-meta",
        )}
      >
        {children}
      </span>
    </div>
  );
}

/** Container for a run of KeyValue rows. Exists so the stack is one decision. */
export function KeyValueList({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col", className)} {...props} />;
}
