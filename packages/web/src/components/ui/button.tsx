import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/components/primitives";

/**
 * Variant and size names are unchanged from the shadcn original on purpose — the
 * feature screens still import this and are rewritten in later phases. Only the
 * paint is new.
 *
 * `default` is ink rather than green: in this design green is the accent that
 * marks a surface or a link, and a page full of green buttons would leave the
 * hero panel with nothing to be.
 */
const buttonVariants = cva(
  "focus-ring inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:bg-nav-active disabled:text-faintest",
  {
    variants: {
      variant: {
        default: "bg-ink text-paper hover:bg-ink-hover",
        secondary: "bg-fill-subtle text-ink hover:bg-fill-hover-strong",
        outline: "border border-hairline-strong bg-surface text-ink hover:bg-fill-hover-card",
        destructive: "bg-danger-tint text-danger hover:bg-danger-tint-hover",
        ghost: "text-quiet hover:bg-fill-hover hover:text-ink",
        accent: "bg-accent text-on-accent hover:bg-accent-hover",
        link: "text-accent underline-offset-4 hover:text-accent-hover hover:underline",
      },
      size: {
        default: "text-body h-10 rounded-control px-4",
        sm: "text-meta h-9 rounded-control px-3.75",
        lg: "text-btn-sm h-12 rounded-control-m px-8",
        icon: "size-10 rounded-nav",
        /** Phone full-width primary — the "Pay S$4.50" / "Scan to pay" button. */
        tall: "text-btn h-14 w-full rounded-card",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
