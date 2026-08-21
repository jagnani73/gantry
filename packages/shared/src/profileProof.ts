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
 * No GANTRY contract verifies this digest — `setMerchantProfile` takes no
 * signature — so unlike `buildSpendAuthorization` this is not a cross-stack pin
 * and has no Foundry vector. A contract-account payout's own `isValidSignature`
 * DOES see it, through viem's universal validator on the backend's slow tier,
 * which is why "nothing verifies this in Solidity" is no longer the right way to
 * put it.
 *
 * The requirement that remains is that the browser and the backend build it
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

/**
 * Signature length bounds, in bytes.
 *
 * A raw ECDSA signature is exactly 65. An ERC-6492 one wraps that with the
 * factory address and its deploy calldata, so it is longer and has no fixed
 * size — hence a floor and a generous ceiling rather than an equality.
 *
 * The ceiling is a cost bound, not a correctness one. Without it the only limit
 * is the JSON body cap, and a ~99KB "signature" would buy a registry read plus a
 * deployless `eth_call` carrying that payload to every fallback provider, times
 * viem's retries. The floor is what keeps four bytes of junk from doing the
 * same.
 */
export const MIN_PROOF_SIGNATURE_BYTES = 65;
export const MAX_PROOF_SIGNATURE_BYTES = 8192;

/**
 * Is this even shaped like a signature? Cheap, total, and no I/O, so it can run
 * before anything expensive.
 *
 * Checks EVEN length as well as the bounds: a hex regex alone admits an odd
 * number of nibbles, which is not a byte string at all, and `(len - 2) / 2`
 * silently yields a fraction that compares as though it were a real size.
 */
export function isSignatureShaped(signature: string): boolean {
  if (!/^0x[0-9a-fA-F]*$/.test(signature)) return false;
  const nibbles = signature.length - 2;
  if (nibbles % 2 !== 0) return false;
  const bytes = nibbles / 2;
  return bytes >= MIN_PROOF_SIGNATURE_BYTES && bytes <= MAX_PROOF_SIGNATURE_BYTES;
}

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
 * Who signed this edit, if anyone.
 *
 * Two outcomes, and callers must handle both. A TAMPERED field returns a
 * different address, so the caller's job is to compare against the payout and
 * never to treat "it returned" as "it verified". Bytes that are not an ECDSA
 * signature at all THROW — measured: `0x` + `11` repeated 65 times rejects
 * rather than returning, so the once-stated "any 65 bytes recover to something"
 * was wrong.
 *
 * That distinction is load-bearing for the backend's two-tier check: an ERC-6492
 * signature from a contract account lands in the throwing case, and falling
 * through to the chain rather than refusing is what lets such an account be
 * verified at all.
 *
 * Takes the proof as its OWN argument rather than intersecting it into the
 * params, so `issuedAt` has exactly one home. As
 * `ProfileEditParams & { signature }` both objects carried an `issuedAt`, both
 * spread orders typechecked, and they produced DIFFERENT digests — with the
 * value that gets freshness-checked and the value that gets hashed free to
 * diverge, in the one function that is the whole gate.
 */
export async function recoverProfileEditSigner(
  base: Omit<ProfileEditParams, "issuedAt">,
  proof: ProfileEditProof,
): Promise<Address> {
  const typedData = buildProfileEdit({ ...base, issuedAt: proof.issuedAt });
  return recoverTypedDataAddress({ ...typedData, signature: proof.signature });
}

/**
 * Is this proof fresh enough to act on?
 *
 * Split out from the recovery so the backend can reject a stale one before doing
 * any I/O — the chain read that fetches the payout is the expensive half, and a
 * replayed signature should not be able to buy an `eth_call` per attempt.
 */
export function isProofFresh(issuedAt: number, nowSeconds: number): boolean {
  // INTEGER, not merely finite: `buildProfileEdit` puts this through `BigInt()`,
  // which throws a RangeError on a fraction. Accepting one here would pass a
  // value the module's own builder cannot encode, and the route's `z.number()
  // .int()` is currently the only thing standing in front of that.
  if (!Number.isInteger(issuedAt)) return false;
  if (issuedAt > nowSeconds + PROOF_SKEW_SECONDS) return false;
  return nowSeconds - issuedAt <= PROOF_TTL_SECONDS;
}

/**
 * Is this stamp in MILLISECONDS?
 *
 * Split from staleness because the two need different answers. A millisecond
 * stamp fails `isProofFresh` on the future branch and would surface as "your
 * signature expired, sign again" — advice that cannot work, since re-signing
 * reproduces the same wrong units forever. The same trap the settlements summary
 * endpoint was hardened against, where the answer was a 400 that says so.
 *
 * The threshold is deliberately crude: any plausible SECONDS value is far below
 * this, and any plausible MILLISECONDS value is far above it.
 */
export function looksLikeMilliseconds(issuedAt: number): boolean {
  return Number.isFinite(issuedAt) && Math.abs(issuedAt) > 1e11;
}
