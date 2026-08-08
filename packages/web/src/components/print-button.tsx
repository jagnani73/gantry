"use client";

import { Button } from "@/components/ui/button";

/** `window.print()` needs a browser, so the standalone standee page keeps this
 * one-line client island rather than becoming a client component itself. */
export function PrintButton() {
  return (
    <Button type="button" onClick={() => window.print()}>
      Print standee
    </Button>
  );
}
