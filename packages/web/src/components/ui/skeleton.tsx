import { cn } from "@/components/primitives";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("bg-fill-subtle animate-pulse rounded-control", className)} {...props} />;
}

export { Skeleton };
