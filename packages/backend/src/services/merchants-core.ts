import { isDeceptive, type MerchantProfile } from "@gantry/shared";

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
 * the shop's own handle. */
function renderable(field: keyof MerchantProfile, value: string): Partial<MerchantProfile> {
  const trimmed = value.trim();
  if (!trimmed || isDeceptive(trimmed)) return {};
  return { [field]: trimmed };
}
