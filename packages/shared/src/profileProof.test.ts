import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import { normalizeProfile, type MerchantProfile } from "./profile";
import {
  MAX_PROOF_SIGNATURE_BYTES,
  MIN_PROOF_SIGNATURE_BYTES,
  PROOF_SKEW_SECONDS,
  PROOF_TTL_SECONDS,
  buildProfileEdit,
  isProofFresh,
  isSignatureShaped,
  looksLikeMilliseconds,
  recoverProfileEditSigner,
  type ProfileEditParams,
} from "./profileProof";

/**
 * What this pins is the ONE thing standing between a stranger and every shop
 * name on the rail. `setMerchantProfile` is `onlyRelayer`, so the contract
 * cannot check who asked and the backend's comparison against the payout is the
 * whole control — which makes "does a tampered field recover a different
 * address" a correctness test rather than a formality.
 *
 * No Gantry contract verifies this digest, so unlike agentPolicy.test.ts there
 * is no Foundry vector to pin against. The requirement is that the browser and
 * the backend build it identically, and they do that by both importing the
 * builder tested below.
 */

/** Anvil's first account. A published key, deliberately: this signs test vectors. */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const account = privateKeyToAccount(KEY);

const MERCHANT_ID = "0x5f2b4e8a3c1d7f6091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708" as Hex;
const GANTRY_CORE = "0xE6289ceA9232af61d7e4F30A67a848c0C322cc93" as Address;
const CHAIN_ID = 84532;
const ISSUED_AT = 1_755_772_800;

const PROFILE: MerchantProfile = {
  displayName: "Ah Hock Chicken Rice",
  location: "Maxwell Food Centre",
  blurb: "Hainanese chicken rice, kopi and iced tea since 1987.",
};

type Base = Omit<ProfileEditParams, "issuedAt">;

function base(overrides: Partial<Base> = {}): Base {
  return {
    merchantId: MERCHANT_ID,
    profile: PROFILE,
    chainId: CHAIN_ID,
    gantryCore: GANTRY_CORE,
    ...overrides,
  };
}

async function sign(b: Base, issuedAt = ISSUED_AT): Promise<Hex> {
  return account.signTypedData(buildProfileEdit({ ...b, issuedAt }));
}

test("a signature by the payout recovers that address", async () => {
  const signature = await sign(base());
  const recovered = await recoverProfileEditSigner(base(), { signature, issuedAt: ISSUED_AT });
  assert.equal(recovered, account.address);
});

/**
 * The tamper cases — five over the message fields, plus the timestamp. Each one
 * is a way the backend could be handed a genuine signature over DIFFERENT facts
 * than the ones it is about to write, so each must land somewhere other than the
 * payout. That is what makes the single comparison in `assertOwnsShop`
 * sufficient on its own.
 *
 * Every mutation is a real substitution rather than a whitespace tweak: both
 * sides run `normalizeProfile`, which trims, so a trailing-space vector could
 * never reach the comparison through the route and would only be proving that
 * EIP-712 is byte-sensitive, which is not in doubt.
 */
for (const [what, mutated] of [
  ["displayName", base({ profile: { ...PROFILE, displayName: "Ah Hock Chicken Rice II" } })],
  ["location", base({ profile: { ...PROFILE, location: "Sim Lim Square" } })],
  ["blurb", base({ profile: { ...PROFILE, blurb: "Cables and chargers." } })],
  ["merchantId", base({ merchantId: `0x${"11".repeat(32)}` as Hex })],
] as const) {
  test(`a tampered ${what} recovers a different address`, async () => {
    const signature = await sign(base());
    const recovered = await recoverProfileEditSigner(mutated, { signature, issuedAt: ISSUED_AT });
    assert.notEqual(
      recovered,
      account.address,
      `tampering with ${what} must not still recover the payout`,
    );
  });
}

test("a tampered issuedAt recovers a different address", async () => {
  const signature = await sign(base());
  const recovered = await recoverProfileEditSigner(base(), {
    signature,
    issuedAt: ISSUED_AT + 1,
  });
  assert.notEqual(recovered, account.address);
});

/**
 * The reason the module gives for choosing EIP-712 over a delimited string is
 * that field boundaries are STRUCTURAL. Every case above changes one field's
 * content; none moves content BETWEEN adjacent fields, so a regression to a
 * concatenated or newline-joined digest would pass all of them.
 *
 * This is the only test that would fail on that regression, which is why it
 * exists separately rather than as another entry in the loop above.
 */
test("content moved between adjacent fields is a different message", async () => {
  const signature = await sign(base({ profile: { ...PROFILE, displayName: "AB", location: "C" } }));
  const recovered = await recoverProfileEditSigner(
    base({ profile: { ...PROFILE, displayName: "A", location: "BC" } }),
    { signature, issuedAt: ISSUED_AT },
  );
  assert.notEqual(recovered, account.address, "a delimited digest would accept this");
});

/**
 * The domain is the free half of the binding: a signature taken from one
 * deployment must not be replayable against another. Both halves matter — a
 * redeploy moves `verifyingContract`, and a fork moves `chainId`.
 */
test("a signature does not carry across deployments", async () => {
  const signature = await sign(base());

  const otherCore = await recoverProfileEditSigner(
    base({ gantryCore: "0x9e51484b1B79bB3E9EaCEfB3D3510Cc19b7Baac1" as Address }),
    { signature, issuedAt: ISSUED_AT },
  );
  assert.notEqual(otherCore, account.address, "another GantryCore must not accept it");

  const otherChain = await recoverProfileEditSigner(base({ chainId: 1 }), {
    signature,
    issuedAt: ISSUED_AT,
  });
  assert.notEqual(otherChain, account.address, "another chain must not accept it");
});

/**
 * The backend's two-tier check depends on this REJECTING rather than returning:
 * an ERC-6492 signature from a contract account is not an ECDSA signature, and
 * falling through to the chain rather than refusing is what lets such an account
 * be verified at all. The docblock once claimed the opposite ("any 65 bytes
 * recover to something"), which would have told a caller not to write the catch.
 */
test("bytes that are not an ECDSA signature reject rather than returning", async () => {
  await assert.rejects(
    recoverProfileEditSigner(base(), { signature: `0x${"11".repeat(65)}` as Hex, issuedAt: ISSUED_AT }),
    "junk of the right LENGTH must still reject, or the fall-through never fires",
  );
});

/**
 * Both sides hash the value `normalizeProfile` returned rather than raw input,
 * so the browser signing `normalize(draft)` and the backend verifying
 * `normalize(body)` only agree if a second pass is a no-op.
 */
test("normalizeProfile is idempotent, so both sides hash the same bytes", () => {
  const once = normalizeProfile({
    displayName: "  Ah Hock Chicken Rice  ",
    location: "\tMaxwell Food Centre\n",
    blurb: " Since 1987. ",
  });
  assert.ok(once.ok);
  const twice = normalizeProfile(once.value);
  assert.ok(twice.ok);
  assert.deepEqual(twice.value, once.value);
});

test("freshness accepts a proof inside the window and refuses a stale one", () => {
  const now = 1_755_772_800;
  assert.equal(isProofFresh(now, now), true);
  assert.equal(isProofFresh(now - PROOF_TTL_SECONDS, now), true, "the boundary is inclusive");
  assert.equal(isProofFresh(now - PROOF_TTL_SECONDS - 1, now), false);
});

/**
 * `issuedAt` comes off the SIGNER's clock and is checked against the server's,
 * so a device running slightly fast must not have every save refused for a
 * reason invisible at both ends.
 */
test("freshness tolerates a fast client clock but not an arbitrary future stamp", () => {
  const now = 1_755_772_800;
  assert.equal(isProofFresh(now + PROOF_SKEW_SECONDS, now), true);
  assert.equal(isProofFresh(now + PROOF_SKEW_SECONDS + 1, now), false);
});

/**
 * INTEGER, not merely finite. `buildProfileEdit` puts this through `BigInt()`,
 * which throws on a fraction, so accepting one would clear the gate with a value
 * the module's own builder cannot encode.
 */
test("freshness refuses a stamp the builder could not encode", () => {
  const now = 1_755_772_800;
  assert.equal(isProofFresh(Number.NaN, now), false);
  assert.equal(isProofFresh(Number.POSITIVE_INFINITY, now), false);
  assert.equal(isProofFresh(now + 0.5, now), false, "a fraction would throw in BigInt()");
  assert.throws(() => buildProfileEdit({ ...base(), issuedAt: now + 0.5 }));
});

/**
 * A millisecond stamp must be diagnosed as a UNIT error, not as staleness: it
 * fails freshness on the future branch, and "sign it again" is advice that can
 * never work because re-signing reproduces the same wrong units forever.
 */
test("a millisecond stamp is recognised as one", () => {
  assert.equal(looksLikeMilliseconds(1_755_772_800_000), true);
  assert.equal(looksLikeMilliseconds(1_755_772_800), false);
  assert.equal(looksLikeMilliseconds(0), false);
  assert.equal(isProofFresh(1_755_772_800_000, 1_755_772_800), false, "and is still not fresh");
});

/**
 * The shape gate runs before any I/O, so its job is to keep junk from buying an
 * `eth_call`. The EVEN-length case is the one that leaked: the route's hex regex
 * admits an odd number of nibbles, and `(len - 2) / 2` then yields a fraction
 * that compares as though it were a real byte count.
 */
test("signature shape refuses anything that is not a byte string in range", () => {
  const ok = `0x${"11".repeat(MIN_PROOF_SIGNATURE_BYTES)}`;
  assert.equal(isSignatureShaped(ok), true);
  assert.equal(isSignatureShaped(`0x${"11".repeat(MAX_PROOF_SIGNATURE_BYTES)}`), true);

  assert.equal(isSignatureShaped("0xdeadbeef"), false, "too short");
  assert.equal(isSignatureShaped(`0x${"11".repeat(MIN_PROOF_SIGNATURE_BYTES - 1)}`), false);
  assert.equal(
    isSignatureShaped(`0x${"11".repeat(MAX_PROOF_SIGNATURE_BYTES + 1)}`),
    false,
    "past the ceiling that bounds validator calldata",
  );
  assert.equal(
    isSignatureShaped(`0x${"a".repeat(131)}`),
    false,
    "odd nibble count measures 65.5 bytes and used to clear a `< 65` test",
  );
  assert.equal(isSignatureShaped(`${"11".repeat(65)}`), false, "no 0x prefix");
  assert.equal(isSignatureShaped(`0x${"zz".repeat(65)}`), false, "not hex");
});
