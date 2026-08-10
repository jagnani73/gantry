/**
 * The five merchant screens, as routes rather than as a `page` state variable.
 *
 * A back-office a merchant is meant to leave open on a counter needs its screens
 * to survive a refresh and to be linkable — "open your QR" in a rehearsal is a
 * URL, not a click path. The sidebar derives its active item from the pathname,
 * so there is no second source of truth for which screen is showing.
 *
 * There was a sixth, Shop profile, until Settings was found to be a read-only
 * echo of it: `/merchant/[handle]/profile` still resolves, as a redirect.
 */
export const MERCHANT_SCREENS = [
  "overview",
  "transactions",
  "payouts",
  "qr",
  "settings",
] as const;

export type MerchantScreen = (typeof MERCHANT_SCREENS)[number];

export const SCREEN_LABEL: Record<MerchantScreen, string> = {
  overview: "Overview",
  transactions: "Transactions",
  payouts: "Payouts",
  qr: "QR & standee",
  settings: "Settings",
};

export function merchantHref(handle: string, screen: MerchantScreen): string {
  return `/merchant/${handle}/${screen}`;
}

/**
 * Where every merchant link lands: the last seven days at a glance, plus the
 * live feed.
 *
 * Named Overview rather than Settlements because the screen beside it lists
 * settlements too. Two nav items called "Settlements" and "Transactions" say
 * nothing about which one a merchant wants; "Overview" (a rolling seven days,
 * live) against "Transactions" (the whole book, searchable) says it in the
 * label.
 */
export const DEFAULT_SCREEN: MerchantScreen = "overview";

/** The shop a handle-less link falls back to — the one that is always
 * registered and always has rows. Deliberately a literal rather than an import
 * from the landing page's copy module: this is a routing fallback, and a route
 * should not break because a marketing constant was renamed. */
export const DEMO_MERCHANT_HANDLE = "ah-hock-chicken-rice";
