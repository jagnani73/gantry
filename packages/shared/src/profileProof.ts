import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import type { MerchantProfile } from "./profile";

/**
 * The merchant's proof that they own the shop they are renaming.
 *
 * `PATCH /api/merchants/:handle` relays `setMerchantProfile`, which is
 * `onlyRelayer` — so the contract cannot check who asked, and for a long time
 * nothing did: the route was bounded by a per-IP cooldown, a per-handle cooldown
 * and a daily budget, all of which answer "how often" and none of which answers
 * "who". The chain already holds the answer. `setMerchantPayout` is gated on
 * `msg.sender == merchant.payout`, so a merchant can always prove ownership by
 * signing with the key their money lands in, and that is what this carries.
 *
 * EIP-712 rather than a `personal_sign` string, for three reasons and not for
 * house style alone:
 *
 *  - The wallet renders it as a labelled table. A merchant approving a rename
 *    can read which shop and which text they are approving.
 *  - The domain binds `chainId` and the GantryCore address, so a signature
 *    cannot be replayed against another deployment for free.
 *  - Field boundaries are STRUCTURAL. A newline-delimited string would lean on
 *    `normalizeProfile` rejecting control characters to stop one field being
 *    smuggled into the next — and that rejection is a content rule about what
 *    reads as a shop name, not a security boundary. Coupling the two means a
 *    future relaxation of the content rule silently becomes a signature bug.
 *
 * There is NO on-chain counterpart: nothing verifies this digest in Solidity,
 * because `setMerchantProfile` takes no signature. So unlike
 * `buildSpendAuthorization` this is not a cross-stack pin and has no Foundry
 * vector — the only requirement is that the browser and the backend build it
 * identically, which is why there is exactly one builder and both import it.
 */

export const PROFILE_EDIT_DOMAIN = { name: "Gantry", version: "1" } as const;

export const PROFILE_EDIT_TYPES = {
  ProfileEdit: [
    { name: "merchantId", type: "bytes32" },
    { name: "displayName", type: "string" },
    { name: "location", type: "string" },
    { name: "blurb", type: "string" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;

/**
 * How long a signature stays good for. Short, because the window is the only
 * thing bounding replay: the message commits to the exact profile text, so a
 * captured signature can only rewrite the shop to text it already contains —
 * but within this window it could roll a LATER edit back to that text.
 *
 * Closing that fully would mean binding the profile currently on-chain, which
 * makes a signature single-use and also makes an ordinary stale browser tab fail
 * its save. Refusing a merchant's legitimate edit is the more likely event of
 * the two, so the window stands and the residue is documented rather than
 * designed away.
 */
export const PROOF_TTL_SECONDS = 300;

/**
 * Future tolerance. `issuedAt` is stamped from the SIGNER's clock and checked
 * against the server's, so a device running a minute fast would otherwise have
 * every signature refused as issued in the future — a failure whose real cause
 * is invisible from either end.
 */
export const PROOF_SKEW_SECONDS = 60;

/** What the client sends alongside the profile it wants written. */
export interface ProfileEditProof {
  signature: Hex;
  /** Unix SECONDS, matching every other display timestamp on the wire. */
  issuedAt: number;
}

export interface ProfileEditParams {
  /** The shop being renamed. Binds the signature to one merchant. */
  merchantId: Hex;
  /**
   * The profile as `normalizeProfile` returned it, never raw input. Both sides
   * normalise (the browser before signing, the backend before verifying), and
   * both must hash the same bytes — `normalizeProfile` only trims, so it is
   * idempotent and the second pass is a no-op.
   */
  profile: MerchantProfile;
  issuedAt: number;
  chainId: number;
  /** GantryCore — the EIP-712 verifyingContract. */
  gantryCore: Address;
}

/** Ready for viem signTypedData / recoverTypedDataAddress. */
export function buildProfileEdit(params: ProfileEditParams) {
  return {
    domain: {
      ...PROFILE_EDIT_DOMAIN,
      chainId: params.chainId,
      verifyingContract: params.gantryCore,
    },
    types: PROFILE_EDIT_TYPES,
    primaryType: "ProfileEdit",
    message: {
      merchantId: params.merchantId,
      displayName: params.profile.displayName,
      location: params.profile.location,
      blurb: params.profile.blurb,
      issuedAt: BigInt(params.issuedAt),
    },
  } as const;
}

/**
 * Who signed this edit.
 *
 * Recovery ALWAYS produces an address — there is no "invalid signature" answer
 * short of malformed bytes, because any 65 bytes recover to something. So the
 * caller's job is to compare the result against the payout, and a tampered field
 * shows up as a different address rather than as a thrown error. Callers must
 * never treat "it returned" as "it verified".
 */
export async function recoverProfileEditSigner(
  params: ProfileEditParams & { signature: Hex },
): Promise<Address> {
  const typedData = buildProfileEdit(params);
  return recoverTypedDataAddress({ ...typedData, signature: params.signature });
}

/**
 * Is this proof fresh enough to act on?
 *
 * Split out from the recovery so the backend can reject a stale one before doing
 * any I/O — the chain read that fetches the payout is the expensive half, and a
 * replayed signature should not be able to buy an `eth_call` per attempt.
 */
export function isProofFresh(issuedAt: number, nowSeconds: number): boolean {
  if (!Number.isFinite(issuedAt)) return false;
  if (issuedAt > nowSeconds + PROOF_SKEW_SECONDS) return false;
  return nowSeconds - issuedAt <= PROOF_TTL_SECONDS;
}
