import { cn } from "@/lib/utils";

/** Every screen opens the same way: a title, one line saying what it is, and at
 * most one action. Shared so the six of them cannot drift by a few pixels. */
export function ScreenHeader({
  title,
  children,
  action,
  className,
}: {
  title: string;
  /** The sub-line. Kept as a node so a screen can put a live figure in it. */
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="text-page-title">{title}</h1>
        {children ? <p className="mt-1.5 text-body text-muted">{children}</p> : null}
      </div>
      {action}
    </div>
  );
}
