import * as React from "react";
import { cn } from "@/components/primitives";

/**
 * Inputs are a fill, not an outline — same rule as cards. The border only appears
 * on invalid state, where an edge is the point.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "text-input focus-ring bg-fill-hover text-ink placeholder:text-faint rounded-control aria-invalid:border-danger flex h-10 w-full px-3.5 py-2.75 aria-invalid:border disabled:cursor-not-allowed disabled:bg-nav-active disabled:text-faintest",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
