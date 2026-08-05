/** Seeded FixedRateSwap rate: XSGD (6dp) out per 1e6 base units in → 1.3421 SGD/USDC. */
export const DEMO_RATE = 1_342_100n;

export const DEFAULT_INTENT_TTL_SECONDS = 600;

/** Protocol fee (skimmed in _settle) and the card-fee comparison used in the dashboard. */
export const GANTRY_FEE_BPS = 50;
export const CARD_FEE_BPS = 280;

/** Off-chain display facts for demo merchants (chain stores only handle/payout/category). */
export const DEMO_MERCHANTS: Record<string, { displayName: string; location: string }> = {
  "ah-hock-chicken-rice": {
    displayName: "Ah Hock Chicken Rice",
    location: "Maxwell Food Centre",
  },
};
