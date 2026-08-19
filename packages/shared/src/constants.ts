/** Seeded FixedRateSwap rate: XSGD (6dp) out per 1e6 base units in → 1.3421 SGD/USDC. */
export const DEMO_RATE = 1_342_100n;

/**
 * The same thing for EURC → 1.51 SGD/EURC, listed on the live swap by one owner
 * transaction rather than seeded at deploy.
 *
 * Here for the same reason `DEMO_RATE` is: several places need to say what S$5
 * or S$50 is worth in a token, and until now this figure existed only inside a
 * transaction and in prose, where it can rot silently. It is a MIRROR of chain
 * state, never the source — anything settling money reads `rateOf` — so if the
 * owner re-rates EURC, this is a thing to update, not a thing to trust.
 */
export const DEMO_RATE_EURC = 1_510_000n;

/** Protocol fee (skimmed in _settle) and the card-fee comparison used in the dashboard. */
export const GANTRY_FEE_BPS = 50;
export const CARD_FEE_BPS = 280;

/**
 * The canonical demo shop. The landing page's entry links, the onboarding gate's
 * example and demo-reset's cheat sheet all point at it — three literals that
 * would drift apart the moment the demo merchant changes, and only one of them
 * would fail loudly.
 */
export const DEMO_MERCHANT_HANDLE = "ah-hock-chicken-rice";

/** Off-chain display facts for demo merchants (chain stores only handle/payout/category). */
export const DEMO_MERCHANTS: Record<
  string,
  { displayName: string; location: string; blurb: string; categoryId: number }
> = {
  "ah-hock-chicken-rice": {
    displayName: "Ah Hock Chicken Rice",
    location: "Maxwell Food Centre",
    blurb: "Hainanese chicken rice, kopi and iced tea since 1987.",
    categoryId: 1, // food_beverage — the door the agent policy allows
  },
  "gadgethub-sg": {
    displayName: "GadgetHub SG",
    location: "Sim Lim Square",
    blurb: "Cables, chargers and power banks.",
    categoryId: 2, // electronics — the category the rejection beat is refused on
  },
};

/**
 * The canonical demo agent policy — "S$50/day" stored on-chain in the spend
 * token's 6dp units at the pinned 1.3421 rate: ceil(50e6 * 1e6 / DEMO_RATE).
 * Used by DeployPBM.s.sol (mirrored constants) and by `demo-reset`, which arms
 * the policy with the PAYER's key and reads it back through
 * `GET /api/agents/:wallet`. There is no admin re-arm endpoint and no
 * `GET /api/policy` any more: agent wallets are payer-owned, `setPolicy` is
 * `onlyOwner`, and no server key can write one.
 */
export const DEMO_POLICY = {
  dailyCap: 37_255_049n,
  perTxCap: 37_255_049n,
  /** food_beverage only (bit 1). */
  categoryBitmap: 1n << 1n,
  policyTtlSeconds: 30 * 24 * 60 * 60,
} as const;

/**
 * `GantryCore.MAX_DENIAL_REASON_BYTES`, mirrored for the backend that has to
 * respect it BEFORE sending.
 *
 * Mirrored rather than read from the chain because the denial path must not grow
 * an RPC call — but a mirror that drifts is worse than no mirror: if the
 * contract's bound ever drops below this, the backend sends a payload the core
 * refuses, `cancelIntentWithReason` reverts, and the retry loses the reason. A
 * backend test pins this against the regenerated ABI's own constant so the two
 * cannot part company silently.
 */
export const MAX_DENIAL_REASON_BYTES = 256;
