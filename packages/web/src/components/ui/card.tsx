import * as React from "react";
import { cn } from "@/components/primitives";

/**
 * The shadcn composition (`Card` / `CardHeader` / `CardTitle` / …) kept intact for
 * the feature screens that still import it. New work uses `<Card>` from
 * primitives, which takes tone/radius/pad instead of assuming one shape.
 *
 * The border and shadow are gone rather than restyled: in this design a card is
 * distinguished from the page by being white on paper, and outlining it as well
 * reads as a second, competing edge.
 */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("bg-surface text-ink rounded-card", className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 p-6", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-card-title-sm", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-body text-muted", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-6 pt-0", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center p-6 pt-0", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
