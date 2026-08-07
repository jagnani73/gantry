/** Merchant categories. On-chain constraint: uint16 < 256 (future one-word PBM bitmap). */
export const CATEGORIES: Record<number, string> = {
  1: "food_beverage",
  2: "electronics",
  3: "retail",
  4: "transport",
};

/** Human-readable labels for the onboarding dropdown; CATEGORIES holds wire names. */
export const CATEGORY_LABELS: Record<number, string> = {
  1: "Food & Beverage",
  2: "Electronics",
  3: "Retail",
  4: "Transport",
};

export interface CategoryOption {
  id: number;
  /** snake_case wire name, as stored in CATEGORIES and echoed by the API. */
  name: string;
  label: string;
}

export const CATEGORY_OPTIONS: readonly CategoryOption[] = Object.keys(CATEGORIES)
  .map(Number)
  .sort((a, b) => a - b)
  .map((id) => ({ id, name: CATEGORIES[id]!, label: CATEGORY_LABELS[id] ?? CATEGORIES[id]! }));

/**
 * The chain accepts any categoryId < 256, and AgentPBMWallet's categoryBitmap
 * is a uint256 — so a bit exists for every id, and an owner could allow one of
 * these on-chain. What an unlisted id lacks is a name, a label, and a bit in
 * the DEMO policy: it renders as `category_7` in every UI and no agent here can
 * spend at it. Registration therefore narrows to the known set while the
 * contract stays permissive.
 */
export function isKnownCategory(id: number): boolean {
  return Number.isInteger(id) && Object.prototype.hasOwnProperty.call(CATEGORIES, id);
}

export function categoryName(id: number): string {
  return CATEGORIES[id] ?? `category_${id}`;
}
