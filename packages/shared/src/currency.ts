import type { TokenId } from "./tokens";

/**
 * What currency a PAYER reads a price in. Never what a merchant receives.
 *
 * The merchant's side is not configurable and cannot be: `GantryCore`'s XSGD is
 * `immutable`, set in the constructor, so the settlement asset is fixed for the
 * life of a deployment. Everything here is a reading aid laid over a price that
 * is denominated, quoted and settled in XSGD regardless.
 *
 * The distinction that matters, and the reason `RateSource` is a union rather
 * than a number: two of these currencies have a token behind them and one does
 * not. USD and EUR convert at the rate `FixedRateSwap` will actually enforce
 * when the payer signs. INR converts at a constant we picked. Presenting those
 * as the same kind of number would be the single most misleading thing this
 * app could do, so the type refuses to let a caller forget which it is holding.
 */

const ONE = 1_000_000n;

export type DisplayCurrencyCode = "SGD" | "USD" | "EUR" | "INR";

export type RateSource =
  /** The settlement unit itself. No conversion exists to get wrong. */
  | { kind: "settlement" }
  /**
   * Backed by a payable token, converted at the live `FixedRateSwap.rateOf`
   * for it — the same number `createIntent` pins and `_settle` enforces. Exact,
   * and checkable on-chain.
   */
  | { kind: "onchain"; token: TokenId }
  /**
   * No token exists for this currency on Base Sepolia, so there is nothing
   * on-chain to read and nothing a payer can sign. A reference only.
   *
   * `perSgd` is minor units of this currency per 1 XSGD, 6dp.
   */
  | { kind: "indicative"; perSgd: bigint };

export interface DisplayCurrency {
  code: DisplayCurrencyCode;
  /** Rendered inline before the digits, matching how `S$` is used today. */
  symbol: string;
  label: string;
  source: RateSource;
}

/**
 * Deliberately ROUND indicative rates.
 *
 * A figure like 64.8317 reads as a live quote pulled from somewhere. 65.00
 * reads as what it is — a number a human chose so a payer can tell whether a
 * price is large or small. There is no FX feed in this system and adding one
 * would put a network dependency in front of the demo's most important screen,
 * on venue wifi, to make a caveat look more precise than it is.
 */
export const INDICATIVE_RATES_AS_OF = "August 2026";

export const DISPLAY_CURRENCIES: Record<DisplayCurrencyCode, DisplayCurrency> = {
  SGD: { code: "SGD", symbol: "S$", label: "Singapore Dollar", source: { kind: "settlement" } },
  USD: { code: "USD", symbol: "US$", label: "US Dollar", source: { kind: "onchain", token: "USDC" } },
  /**
   * Indicative TODAY, and structurally ready to stop being so. Listing a EURC
   * rate on `FixedRateSwap` and adding the token to `TOKENS` is all that stands
   * between this and `{ kind: "onchain", token: "EURC" }` — the swap's `rateOf`
   * is an open mapping and `GantryCore` holds no token allowlist, so that is an
   * owner transaction rather than a redeploy.
   */
  EUR: { code: "EUR", symbol: "€", label: "Euro", source: { kind: "indicative", perSgd: 700_000n } },
  /**
   * Indicative and likely to stay so: there is no INR stablecoin on Base
   * Sepolia to settle against, so this can never become an `onchain` source
   * however long the demo runs. An Indian visitor holds USDC and reads rupees.
   */
  INR: { code: "INR", symbol: "₹", label: "Indian Rupee", source: { kind: "indicative", perSgd: 65_000_000n } },
};

export const DISPLAY_CURRENCY_CODES = Object.keys(DISPLAY_CURRENCIES) as [
  DisplayCurrencyCode,
  ...DisplayCurrencyCode[],
];

export function isDisplayCurrencyCode(value: string): value is DisplayCurrencyCode {
  return value in DISPLAY_CURRENCIES;
}

/** The token whose on-chain rate this currency reads, or null if it has none. */
export function currencyToken(currency: DisplayCurrency): TokenId | null {
  return currency.source.kind === "onchain" ? currency.source.token : null;
}

/**
 * XSGD 6dp units → this currency's 6dp units.
 *
 * Returns **null** when an on-chain rate is required and absent, rather than
 * falling back to some other number. A dropped rate must render as "unavailable":
 * substituting an indicative figure for an exact one, silently, is how a payer
 * ends up told a price the contract will not honour.
 *
 * Rounds half-up rather than truncating. These are reference figures shown
 * behind a `≈`, and truncation makes a rate of exactly 0.70 print as 0.69 on
 * the amounts most likely to be on screen.
 */
export function referenceAmount(
  xsgdUnits: bigint,
  currency: DisplayCurrency,
  onchainRate: bigint | null,
): bigint | null {
  if (xsgdUnits < 0n) return null;
  const { source } = currency;
  if (source.kind === "settlement") return xsgdUnits;
  if (source.kind === "indicative") {
    return (xsgdUnits * source.perSgd + ONE / 2n) / ONE;
  }
  // `rateOf` is XSGD out per 1e6 of the token in, so the payer-side amount is
  // the inverse. A zero or absent rate is the swap saying the token is not
  // listed, which is exactly when a converted figure would be fiction.
  if (onchainRate === null || onchainRate <= 0n) return null;
  return (xsgdUnits * ONE + onchainRate / 2n) / onchainRate;
}

/**
 * Is this figure the rate the chain will actually enforce, or our constant?
 *
 * Every render site has to caption its number, and the caption differs. Kept
 * here so the two cannot drift: a screen that reads the amount from this module
 * reads its provenance from the same place.
 */
export function isExact(currency: DisplayCurrency): boolean {
  return currency.source.kind !== "indicative";
}
