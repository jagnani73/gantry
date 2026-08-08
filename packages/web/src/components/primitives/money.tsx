import * as React from "react";
import { cn } from "./cn";
import { TEXT_TONE, type Tone } from "./tone";
import { formatUnits, type Units } from "./units";

/**
 * The two voices a quantity has in this design.
 *
 * `amount` is what the shop or the payer is being told they got — sans, 600, and
 * tabular so a column of them lines up. `token` is what actually moved on chain
 * (3.352955 USDC) — mono, because it is closer to an identifier than to a price.
 * Both are tabular-nums; neither is ever hand-formatted at the call site.
 */
type MoneyVariant = "amount" | "token";
type MoneySize = "lg" | "md" | "sm" | "xs";

const AMOUNT_SIZE: Record<MoneySize, string> = {
  lg: "text-amount-lg", // merchant live feed
  md: "text-amount", // merchant transactions table
  sm: "text-amount-sm", // phone rows, payouts net
  xs: "text-row-title", // an amount sitting inline in a sentence
};

const TOKEN_SIZE: Record<MoneySize, string> = {
  lg: "text-mono",
  md: "text-mono-sm",
  sm: "text-mono-xs",
  xs: "text-mono-2xs",
};

export interface MoneyProps extends Omit<React.ComponentProps<"span">, "prefix" | "children"> {
  /** 6dp integer units. bigint or an integer string — never a float. */
  units: Units;
  /** Display decimal places. 2 for prices, 6 when the exact transfer matters. */
  dp?: number;
  /** Currency mark, rendered inline at the same size. Pass null to omit. */
  prefix?: string | null;
  /** Token ticker, e.g. "USDC". Rendered after a space. */
  suffix?: string | null;
  variant?: MoneyVariant;
  size?: MoneySize;
  tone?: Tone;
  /** A declined attempt: the amount is shown, struck, because it never moved. */
  strike?: boolean;
}

export function Money({
  units,
  dp = 2,
  prefix = null,
  suffix = null,
  variant = "amount",
  size = "md",
  tone = "inherit",
  strike = false,
  className,
  ...props
}: MoneyProps) {
  const value = formatUnits(units, dp);
  return (
    <span
      className={cn(
        "tabular-nums",
        variant === "token" ? cn("font-mono", TOKEN_SIZE[size]) : AMOUNT_SIZE[size],
        TEXT_TONE[tone],
        strike && "line-through",
        className,
      )}
      {...props}
    >
      {prefix}
      {value}
      {suffix ? ` ${suffix}` : null}
    </span>
  );
}
