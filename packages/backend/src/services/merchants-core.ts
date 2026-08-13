import type { Hex } from "viem";
import {
  categoryName,
  hasVisibleContent,
  isDeceptive,
  profileFieldLength,
  PROFILE_LIMITS,
  type MerchantProfile,
  type MerchantSummary,
} from "@gantry/shared";
import type { MerchantRow } from "../db-core";

/**
 * Pure profile rules — no config, no chain, no db handle (facilitator-core.ts
 * precedent), so the validation that guards a shop's public identity is testable
 * without an RPC URL or a relayer key.
 *
 * The rules themselves moved to `@gantry/shared` so the onboarding form and the
 * profile editor validate with the SAME code, not merely the same numbers — a
 * form that knew only the ceilings would still accept a direction-override the
 * API rejects, and surface it as a mystery 400 after a permanent handle had
 * already been typed. Re-exported here so this module stays the backend's one
 * import site for profile logic.
 */
export {
  normalizeProfile,
  isDeceptive,
  profileFieldLength,
  PROFILE_LIMITS,
  PROFILE_FIELDS,
  type MerchantProfile,
  type ProfileField,
  type ProfileResult,
} from "@gantry/shared";

/**
 * Display fields as the CHAIN reports them — sanitised on the way OUT.
 *
 * One source now. It used to prefer a SQLite row and fall back to DEMO_MERCHANTS
 * seed data; both are gone with the on-chain move, and the seed fallback went
 * with them — inventing a name for an empty record is exactly what "the chain is
 * the only source" forbids, and it would mask an unnamed shop.
 *
 * The sanitising is the part the move made NECESSARY. While `POST /api/merchants`
 * was the only writer, `normalizeProfile` was a chokepoint and every stored name
 * had already been through it. `registerMerchant` is permissionless and the
 * contract deliberately checks length only — rendering rules do not belong in a
 * settlement contract — so anyone can now write a shop name containing an RLO
 * override, a newline, or zero-width padding straight to the chain, and this
 * function is what stands between that and every Gantry surface. The chokepoint
 * had to move from the write to the read; it could not simply disappear.
 *
 * Absence is the point: a merchant with nothing usable renders as its handle,
 * which is true, where an invented name is not. Trimmed first, because `" "` is
 * a legal on-chain value and is TRUTHY — forwarded raw it renders as a blank
 * name and the handle fallback never fires. Keys are omitted rather than set to
 * undefined, so they never reach the JSON at all.
 */
export function resolveProfile(chain: MerchantProfile): Partial<MerchantProfile> {
  return {
    ...renderable("displayName", chain.displayName),
    ...renderable("location", chain.location),
    ...renderable("blurb", chain.blurb),
  };
}

/** One field, or nothing at all. Deceptive text is DROPPED rather than escaped
 * or repaired: the honest rendering of a name designed to lie about itself is
 * the shop's own handle.
 *
 * The four checks are the same four `normalizeProfile` applies on the write
 * path, and all four have to be here: `registerMerchant` is permissionless, so
 * nothing guarantees a stored value ever met them. `hasVisibleContent` is the
 * one that is easy to leave out — a name of joiners is neither blank nor
 * deceptive, and trims to a non-empty string, so it passes the other two and
 * renders as an invisible shop name with the handle fallback never firing.
 *
 * LENGTH is the one that was left out. The contract bounds these fields in
 * BYTES at 4× the client's codepoint limits — deliberately, so anything
 * `normalizeProfile` accepts always fits — but that arithmetic only holds for
 * text that came through a client. A shop registered straight on chain can
 * store 240 codepoints of `displayName`, and the drawer, the sidebar and the
 * laminated standee do not clamp. Dropped rather than truncated, because
 * absence is this module's answer everywhere else and half a shop name is its
 * own kind of lie. */
function renderable(field: keyof MerchantProfile, value: string): Partial<MerchantProfile> {
  const trimmed = value.trim();
  if (!trimmed || isDeceptive(trimmed) || !hasVisibleContent(trimmed)) return {};
  if (profileFieldLength(trimmed) > PROFILE_LIMITS[field]) return {};
  return { [field]: trimmed };
}

/**
 * The store's own row shape, imported rather than redeclared.
 *
 * A `import type` is erased under `verbatimModuleSyntax`, so this costs nothing
 * at runtime and the module stays as free of the database as `pbm-core.ts` —
 * which already imports `DenialRow` the same way, and is the precedent. A
 * hand-copied shape would compile happily while a column was added to one side
 * and not the other, and TypeScript would not catch that direction: extra
 * properties on a non-literal are assignable, so the mapper would silently
 * ignore the new column.
 */
export type IndexedMerchant = MerchantRow;

/**
 * One swept row → one directory entry.
 *
 * Every row goes through `resolveProfile` on the way out, and that is load
 * bearing rather than tidy: the directory renders text written by anyone who
 * paid gas, since `registerMerchant` is permissionless and the contract checks
 * length only. The read path is the only chokepoint left.
 *
 * `payout` is absent because the store never held it — see MerchantRow. Do not
 * "complete" this mapper by adding a chain read for it: a public list of shops
 * is not a public list of the addresses their money lands in.
 */
export function toMerchantSummary(row: IndexedMerchant): MerchantSummary {
  return {
    handle: row.handle,
    // A keccak hash, so lowercase already IS canonical — this is exactly the
    // value that must never be run through `checksummed`, which would invent
    // capitalisation that means nothing.
    merchantId: row.merchant_id as Hex,
    categoryId: row.category_id,
    categoryName: categoryName(row.category_id),
    ...resolveProfile({
      displayName: row.display_name,
      location: row.location,
      blurb: row.blurb,
    }),
    registeredAt: row.block_time,
    blockNumber: row.block_number,
  };
}
