import type { Hex } from "viem";
import { categoryName, resolveProfile, type MerchantSummary } from "@gantry/shared";
import type { MerchantRow } from "../db-core";

/**
 * Pure row→wire mapping — no config, no chain, no db handle (facilitator-core.ts
 * precedent), so the code that shapes a shop's public identity is testable
 * without an RPC URL or a relayer key.
 *
 * The profile rules themselves all live in `@gantry/shared`, WRITE and READ
 * alike, so the onboarding form, the profile editor and every renderer of
 * on-chain text use the SAME code rather than merely the same numbers — a form
 * that knew only the ceilings would still accept a direction-override the API
 * rejects, and surface it as a mystery 400 after a permanent handle had already
 * been typed. `resolveProfile` moved there for the read side of that same
 * argument: it is the only thing standing between permissionless on-chain text
 * and every payer surface, and a guard only the backend can reach is one the
 * next direct chain read in the browser will silently skip.
 *
 * Re-exported here so this module stays the backend's one import site for
 * profile logic.
 */
export {
  normalizeProfile,
  isDeceptive,
  profileFieldLength,
  resolveProfile,
  PROFILE_LIMITS,
  PROFILE_FIELDS,
  type MerchantProfile,
  type ProfileField,
  type ProfileResult,
} from "@gantry/shared";

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
