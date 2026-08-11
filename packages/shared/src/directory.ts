import { CATEGORY_OPTIONS } from "./categories";

/**
 * The public merchant directory's search and category filter, as pure rules.
 *
 * Filtering is client-side over the whole loaded list, which is only honest
 * while the rail is small: `GET /api/merchants` returns everything and the page
 * sifts it. Past a few hundred merchants this moves to the server, and these
 * predicates are what the query would have to reproduce.
 *
 * Both filters fail OPEN — an unparseable category or an empty query matches
 * everything — for the reason `resolveScope` gives: an unmatchable filter
 * renders a perfectly healthy-looking page that simply never shows a shop, and
 * nothing on screen distinguishes that from a rail with no merchants on it.
 */

/**
 * Blocks behind the head past which the directory must stop asserting that a
 * shop is not registered.
 *
 * Generous on purpose. The sweep runs every 15s against ~2s blocks, so a healthy
 * host sits a handful of blocks behind constantly; a tight bound would put a
 * "still catching up" caveat on a page that is perfectly current, which trains
 * a reader to ignore it. This bound is only meant to catch the real case: a cold
 * or failing host whose lag is thousands of blocks, where the list is a fraction
 * of the rail and the empty state would otherwise claim the rail is empty.
 */
export const INDEX_LAG_TOLERANCE_BLOCKS = 25;

/** Is this host's view of the chain too far behind to make claims from?
 * `null` means no head has been read yet, which is itself "do not claim". */
export function isIndexBehind(lag: number | null | undefined): boolean {
  if (lag === null || lag === undefined) return true;
  return lag > INDEX_LAG_TOLERANCE_BLOCKS;
}

export interface DirectoryFilter {
  /** Already normalised by `resolveDirectoryQuery`. "" means "no search". */
  query: string;
  /** Category id, or null for "All". */
  categoryId: number | null;
}

/** URL `?q=` → a search needle. Lowercased once here so the haystacks and the
 * needle agree without either side re-casing per comparison. */
export function resolveDirectoryQuery(param: string | null | undefined): string {
  if (param === null || param === undefined) return "";
  return param.trim().toLowerCase();
}

/**
 * URL `?category=` → a category id, or null for "All".
 *
 * Matched on the registry's stable `name` slug (`food_beverage`), not on the id
 * and not on the display label: a numeric param would be meaningless in a shared
 * link, and a label is prose that can be reworded without anyone realising a URL
 * depended on it.
 */
export function resolveCategoryFilter(param: string | null | undefined): number | null {
  if (param === null || param === undefined) return null;
  const slug = param.trim().toLowerCase();
  if (slug === "") return null;
  return CATEGORY_OPTIONS.find((option) => option.name === slug)?.id ?? null;
}

/**
 * URL `?shop=` → the handle whose drawer should open, or null for none.
 *
 * Here rather than inline in the component for the reason `?q=` and `?category=`
 * are: the web package has no test runner, so a rule that stays there is a rule
 * nothing checks. This is also the one of the three that decides whether a
 * SHARED link works — the same job `resolveScope` does for `?handle=`, and
 * lowercased for the same reason, since handles are lowercase on-chain and a
 * hand-typed or auto-capitalised link should still find its shop.
 */
export function resolveShopParam(param: string | null | undefined): string | null {
  if (param === null || param === undefined) return null;
  const handle = param.trim().toLowerCase();
  return handle === "" ? null : handle;
}

/** The inverse, for building a link: a category id → its `?category=` value.
 * Unknown ids produce null, i.e. "All" — never `category_7`, which no segment
 * would render as selected. */
export function categoryParam(categoryId: number | null): string | null {
  if (categoryId === null) return null;
  return CATEGORY_OPTIONS.find((option) => option.id === categoryId)?.name ?? null;
}

/**
 * The three fields the search matches, flattened and lowercased.
 *
 * Built per merchant and cached by the caller rather than rebuilt per keystroke.
 * The handle is included because it is what a payer is given on a receipt or a
 * printed standee, and is often the only spelling they have.
 */
export function directoryHaystack(merchant: {
  handle: string;
  displayName?: string;
  location?: string;
}): string {
  return [merchant.displayName ?? "", merchant.handle, merchant.location ?? ""]
    .join(" ")
    .toLowerCase();
}

/** Does one merchant survive the current filter? `haystack` comes from
 * `directoryHaystack`; passing raw text would silently break case-insensitivity
 * for any caller that forgot to lowercase it. */
export function matchesDirectory(
  entry: { haystack: string; categoryId: number },
  filter: DirectoryFilter,
): boolean {
  if (filter.categoryId !== null && entry.categoryId !== filter.categoryId) return false;
  if (filter.query === "") return true;
  return entry.haystack.includes(filter.query);
}
