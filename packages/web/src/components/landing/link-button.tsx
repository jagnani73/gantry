import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The hero's two entry buttons.
 *
 * Local to the landing page rather than promoted: nothing inside either product
 * surface uses a pill this size, and the shared `components/ui/button` is being
 * rewritten onto the tokens in parallel.
 */
type Variant = "ink" | "surface";

const VARIANT: Record<Variant, string> = {
  ink: "bg-ink text-paper hover:bg-ink-hover",
  surface: "bg-surface text-ink hover:bg-fill-hover-card",
};

export interface LinkButtonProps {
  href: string;
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
}

export function LinkButton({ href, variant = "ink", className, children }: LinkButtonProps) {
  return (
    <Link
      href={href}
      className={cn(
        "focus-ring inline-flex items-center rounded-tile px-6.5 py-3.75 text-btn-sm transition-colors",
        VARIANT[variant],
        className,
      )}
    >
      {children}
    </Link>
  );
}
