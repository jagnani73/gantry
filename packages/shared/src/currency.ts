import { VANILLA_DEFAULT_TOKEN, type TokenId } from "./tokens";

/**
 * What currency a PAYER SENDS. Never what a merchant receives.
 *
 * Choosing one of these sets the token on the EIP-3009 authorization, the
 * balance the wallet reads, the rate every S$ figure converts at, and the asset
 * the intent is quoted in. It does not change the shop's side and cannot:
 * `GantryCore.XSGD` is `immutable`, set in the constructor, so the settlement
 * asset is fixed for the life of a deployment. That is the whole claim — any
 * currency in, Singapore dollars out.
 *
 * This module used to describe a READING aid — a currency a price was restated
 * in while the payer still sent USDC — and carried an `indicative` rate arm and
 * a `referenceAmount` converter for the currencies with no token behind them.
 * That went when `PriceReference` was deleted and the token amount became the
 * currency amount: restating a figure in a currency you are also sending prints
 * the same number twice. The supporting code outlived the feature by a while;
 * it is gone now, and nothing here converts anything.
 */

export type DisplayCurrencyCode = "SGD" | "USD" | "EUR" | "INR";

interface CurrencyBase {
  code: DisplayCurrencyCode;
  /** Rendered inline before the digits, matching how `S$` is used today. */
  symbol: string;
  label: string;
}

/**
 * A currency, and whether it is a way to pay.
 *
 * A UNION rather than a `settleable: boolean` beside an optional token, because
 * the two fields are not independent and the illegal combination is the
 * dangerous one. With a flag, `DISPLAY_CURRENCIES.SGD.settleable = true`
 * compiled: SGD would then appear in the picker, `setPayCurrency` would accept
 * it, and `settlementSendToken` — finding no token and falling back — would
 * label the whole flow in S$ while signing an authorization against USDC. The
 * fallback added for safety is what turned a crash into a mislabel.
 *
 * Here a settleable currency cannot exist without naming its token, and an
 * unsettleable one cannot name one. SGD is absent from every payment path by
 * construction rather than by a filter someone can edit.
 */
export type DisplayCurrency =
  | (CurrencyBase & {
      /** The payer signs against this token, and the picker offers it live. */
      settleable: true;
      /** Must be `payable` in `TOKENS` — pinned by test, since the union can
       * enforce that a token is NAMED but not which one. */
      token: TokenId;
    })
  | (CurrencyBase & {
      /** Shown LOCKED rather than hidden. "Any currency in" is the claim, and a
       * reader deserves to see what is true today and what is not. */
      settleable: false;
      token: null;
    });

export const DISPLAY_CURRENCIES: Record<DisplayCurrencyCode, DisplayCurrency> = {
  /**
   * The shop's own currency, and NOT a way to pay: the settlement token is the
   * open-mint `MockXSGD`, which `TOKENS` marks non-payable for that reason.
   * Quoting it would let anyone settle a fabricated payment for free.
   */
  SGD: { code: "SGD", symbol: "S$", label: "Singapore Dollar", settleable: false, token: null },
  /** Real Circle USDC. The currency every demo payer holds. */
  USD: { code: "USD", symbol: "US$", label: "US Dollar", settleable: true, token: "USDC" },
  /**
   * REAL since 19 Aug 2026. Circle's EURC is listed on `FixedRateSwap` at an
   * owner-set 1.510000 XSGD per EURC, so a payer choosing euros signs an
   * EIP-3009 authorization against Circle's own contract and the hawker is
   * still paid in XSGD. It took one owner transaction and no redeploy —
   * `rateOf` is an open mapping and `GantryCore` holds no token allowlist,
   * which is exactly the seam the design claimed.
   *
   * No mock was involved, and that matters: MockXSGD stays the only mocked
   * token in the system.
   */
  EUR: { code: "EUR", symbol: "€", label: "Euro", settleable: true, token: "EURC" },
  /**
   * Locked, and likely to stay so: there is no INR stablecoin on Base Sepolia,
   * so this can never become settleable here however long the demo runs. Shown
   * anyway — hiding it would quietly imply the set is closed.
   */
  INR: { code: "INR", symbol: "₹", label: "Indian Rupee", settleable: false, token: null },
};

export const DISPLAY_CURRENCY_CODES = Object.keys(DISPLAY_CURRENCIES) as [
  DisplayCurrencyCode,
  ...DisplayCurrencyCode[],
];

export function isDisplayCurrencyCode(value: string): value is DisplayCurrencyCode {
  return value in DISPLAY_CURRENCIES;
}

/**
 * Which token a payer's authorization will actually name.
 *
 * Two answers since EURC was listed, which is the whole feature: choosing euros
 * changes the token on the signature, the balance the wallet reads and the
 * asset the intent is quoted in. A currency that cannot be sent falls back to
 * the vanilla default, because a payer looking at a locked currency must still
 * be able to pay.
 */
export function settlementSendToken(currency: DisplayCurrency): TokenId {
  return currency.settleable ? currency.token : VANILLA_DEFAULT_TOKEN;
}

/**
 * The currencies a payer may actually PAY in — the picker's live options.
 *
 * Derived from `settleable` rather than listed, so a currency cannot appear as
 * a way to pay by being typed into a component. SGD is absent by construction
 * and that is correct: it is the OUTPUT, `GantryCore.XSGD` is immutable, and
 * the settlement token is deliberately non-payable.
 */
export const PAYABLE_CURRENCY_CODES = DISPLAY_CURRENCY_CODES.filter(
  (code) => DISPLAY_CURRENCIES[code].settleable,
);

/**
 * What the payer's settings screen offers, in order: every currency that can be
 * sent, then the ones that cannot — which are shown LOCKED rather than hidden.
 *
 * SGD is excluded by `settleable`, not by name. Spelling it as `code !== "SGD"`
 * made the exclusion a string a refactor could lose, while the reason it is
 * excluded — the settlement token is not payable — lives in `TOKENS`.
 */
export const SEND_CURRENCY_OPTIONS: readonly { code: DisplayCurrencyCode; locked: boolean }[] =
  DISPLAY_CURRENCY_CODES.filter((code) => code !== "SGD")
    .map((code) => ({ code, locked: !DISPLAY_CURRENCIES[code].settleable }))
    .sort((a, b) => Number(a.locked) - Number(b.locked));
