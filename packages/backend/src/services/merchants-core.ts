import { DEMO_MERCHANTS, type MerchantProfile } from "@gantry/shared";
import type { MerchantProfileRow } from "../db-core";

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
 * Display fields for a handle, ordered by who is most entitled to set them: the
 * stored profile is what the merchant themselves wrote, DEMO_MERCHANTS is seed
 * data for the two canonical demo shops (and carries no blurb), and a merchant
 * with neither gets NO fields at all.
 *
 * Absence is the point — an unnamed merchant renders as its handle, which is
 * true, where an invented name is not. Keys are omitted rather than set to
 * undefined so they never reach the JSON at all.
 */
export function resolveProfile(
  handle: string,
  stored: MerchantProfileRow | undefined,
): Partial<MerchantProfile> {
  if (stored) {
    return {
      displayName: stored.display_name,
      location: stored.location,
      blurb: stored.blurb,
    };
  }
  const demo = DEMO_MERCHANTS[handle.toLowerCase()];
  return demo ? { displayName: demo.displayName, location: demo.location } : {};
}
