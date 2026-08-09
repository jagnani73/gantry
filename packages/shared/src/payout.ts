import { getAddress, isAddress, zeroAddress, type Address } from "viem";

/**
 * Merchant payout address validation, shared so the form and the route agree.
 *
 * A bare hex regex is NOT enough here. `GantryCore.setMerchantPayout` gates
 * rotation on `msg.sender == merchant.payout`, so a merchant who registers a
 * well-formed but wrong address can never fix it — not through us, not through
 * the contract owner — and every future payment to that handle is lost. EIP-55
 * is the only check standing between a paste error and permanently misrouted
 * funds, so a mixed-case address must match its checksum.
 *
 * Note `getAddress` alone is NOT the check: it validates shape and then simply
 * re-checksums, silently "fixing" a corrupted paste. `isAddress(.., {strict})`
 * is what verifies EIP-55. It accepts all-lowercase (no checksum to verify, so
 * a hand-typed address still works) and rejects both a broken checksum and the
 * all-uppercase form — the latter is rare enough that asking for lowercase is
 * a better trade than accepting an unverifiable address.
 */
export type PayoutResult =
  | { ok: true; address: Address }
  | { ok: false; reason: "malformed" | "bad_checksum" | "zero_address"; message: string };

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function normalizePayout(raw: string): PayoutResult {
  const trimmed = raw.trim();
  if (!HEX_ADDRESS.test(trimmed)) {
    return {
      ok: false,
      reason: "malformed",
      message: "payout must be a wallet address: 0x followed by 40 hex characters",
    };
  }

  if (!isAddress(trimmed, { strict: true })) {
    return {
      ok: false,
      reason: "bad_checksum",
      message:
        "that address's capitalisation doesn't match its checksum, so it may have been mistyped. " +
        "Paste it again from your wallet, or enter it in all lowercase.",
    };
  }
  const checksummed: Address = getAddress(trimmed);

  if (checksummed === zeroAddress) {
    return {
      ok: false,
      reason: "zero_address",
      message: "payout cannot be the zero address: payments to it are unrecoverable",
    };
  }
  return { ok: true, address: checksummed };
}
