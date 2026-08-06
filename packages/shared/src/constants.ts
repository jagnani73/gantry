/** Seeded FixedRateSwap rate: XSGD (6dp) out per 1e6 base units in → 1.3421 SGD/USDC. */
export const DEMO_RATE = 1_342_100n;

/** Protocol fee (skimmed in _settle) and the card-fee comparison used in the dashboard. */
export const GANTRY_FEE_BPS = 50;
export const CARD_FEE_BPS = 280;

/** Off-chain display facts for demo merchants (chain stores only handle/payout/category). */
export const DEMO_MERCHANTS: Record<string, { displayName: string; location: string }> = {
  "ah-hock-chicken-rice": {
    displayName: "Ah Hock Chicken Rice",
    location: "Maxwell Food Centre",
  },
  "gadgethub-sg": {
    displayName: "GadgetHub SG",
    location: "Sim Lim Square",
  },
};

/**
 * The canonical demo agent policy — "S$50/day" stored on-chain in the spend
 * token's 6dp units at the pinned 1.3421 rate: ceil(50e6 * 1e6 / DEMO_RATE).
 * Used by DeployPBM.s.sol (mirrored constants), the admin re-arm endpoint, and
 * demo-reset's printed verification.
 */
export const DEMO_POLICY = {
  dailyCap: 37_255_049n,
  perTxCap: 37_255_049n,
  /** food_beverage only (bit 1). */
  categoryBitmap: 1n << 1n,
  policyTtlSeconds: 30 * 24 * 60 * 60,
} as const;
