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
 * The chain accepts any categoryId < 256, but only these four have a name, a
 * label and a PBM bitmap bit that the demo policy knows about — an unlisted id
 * renders as `category_7` everywhere and can never be allowed by a policy.
 * Registration therefore narrows to the known set; the contract stays permissive.
 */
export function isKnownCategory(id: number): boolean {
  return Number.isInteger(id) && Object.prototype.hasOwnProperty.call(CATEGORIES, id);
}

export function categoryName(id: number): string {
  return CATEGORIES[id] ?? `category_${id}`;
}
