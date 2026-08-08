import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/components/primitives";

/**
 * Kept for the feature screens that still import it; new work should reach for
 * `<Chip>` in primitives, which carries the design's actual chip geometry.
 * Variant names are unchanged so those screens keep compiling.
 */
const badgeVariants = cva("text-chip inline-flex items-center gap-1.5 whitespace-nowrap", {
  variants: {
    variant: {
      default: "bg-accent-tint text-accent rounded-chip-sm px-2.5 py-1.25",
      secondary: "bg-fill-subtle text-quiet rounded-chip-sm px-2.5 py-1.25",
      destructive: "bg-danger-tint text-danger rounded-chip-sm px-2.5 py-1.25",
      outline: "border-hairline-strong text-quiet rounded-chip-sm border px-2.5 py-1",
    },
  },
  defaultVariants: { variant: "default" },
});

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
