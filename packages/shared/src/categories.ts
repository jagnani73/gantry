/** Merchant categories. On-chain constraint: uint16 < 256 (future one-word PBM bitmap). */
export const CATEGORIES: Record<number, string> = {
  1: "food_beverage",
  2: "electronics",
  3: "retail",
  4: "transport",
};

export function categoryName(id: number): string {
  return CATEGORIES[id] ?? `category_${id}`;
}
