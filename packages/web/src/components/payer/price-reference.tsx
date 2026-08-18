"use client";

import { formatUnits6, isExact, referenceAmount } from "@gantry/shared";
import { cn } from "@/lib/utils";
import { usePayer } from "./payer-context";

/**
 * The price again, in whatever currency the payer reads — beside the real
 * figure, never in place of it.
 *
 * Three rules hold this together, and each one is a way this could mislead:
 *
 *  - **SGD renders nothing.** The primary figure already IS Singapore dollars,
 *    and repeating it under an `≈` would suggest the two were different numbers.
 *  - **A failed rate read renders "unavailable", not a fallback.** The on-chain
 *    currencies convert at `FixedRateSwap.rateOf`; if that read failed there is
 *    no honest number to show, and quietly substituting the indicative table
 *    would put a figure the contract will not honour next to a Pay button.
 *  - **Indicative currencies say so, every time.** Euro and rupee have no token
 *    on this chain, so nobody can sign for them and no rate is enforced. A
 *    payer cannot tell that from the digits, so the label carries it.
 */
export function PriceReference({
  xsgdUnits,
  tone = "default",
  className,
}: {
  xsgdUnits: bigint;
  tone?: "default" | "on-accent";
  className?: string;
}) {
  const { displayCurrency, rate } = usePayer();

  if (displayCurrency.source.kind === "settlement") return null;

  const amount = referenceAmount(xsgdUnits, displayCurrency, rate);
  const muted = tone === "on-accent" ? "text-on-accent-muted" : "text-faint";

  if (amount === null) {
    return (
      <p className={cn("mt-1.5 text-meta", muted, className)}>
        {displayCurrency.code} unavailable — the rate could not be read
      </p>
    );
  }

  return (
    <p className={cn("mt-1.5 text-meta", muted, className)}>
      ≈ {displayCurrency.symbol}
      {formatUnits6(amount)}
      {isExact(displayCurrency) ? null : " · indicative"}
    </p>
  );
}
