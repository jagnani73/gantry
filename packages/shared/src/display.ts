import { getAddress, isAddress, type Address } from "viem";
import { BASESCAN_BASE_URL } from "./addresses";

/**
 * Display helpers every surface needs and would otherwise each reinvent —
 * address truncation was already written three times before this module existed,
 * with no guarantee the merchant feed and the payer receipt truncated the same
 * address to the same string.
 */

/**
 * `0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0` → `0x6F02…5Ce0`.
 *
 * Keeps the leading `0x` and both ends, because those are what a human compares
 * against Basescan. Casing is preserved rather than normalised: an EIP-55
 * address carries its checksum in the capitalisation, and lowercasing it here
 * would quietly discard the only thing that makes a pasted address verifiable.
 * Anything too short to truncate is returned unchanged instead of padded.
 */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  return address.length <= lead + tail + 1 ? address : `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * A stored address → the form a person can check. The counterpart to the rule
 * above, applied one layer earlier.
 *
 * Every id column in the backend store is lowercased on write, deliberately: the
 * lookups are case-sensitive `=`, so a checksummed caller must not be able to
 * cause a silent cache miss. That makes lowercase the right KEY and the wrong
 * ANSWER — by the time a row reaches a receipt or a Basescan link, the
 * capitalisation is the whole checksum and dropping it leaves nothing an eye can
 * verify. Row→wire mappers call this so a row that went through SQLite reads
 * identically to the same row pushed live off a decoded log.
 *
 * Anything that is not a 20-byte address comes back UNCHANGED rather than
 * throwing. These callers sit on the live feed's only path, where one
 * unrecognisable value must cost that one field and never the whole page — the
 * same posture `tokenIdByAddress` already takes toward a token it cannot name.
 * Hashes are not addresses and must not be passed here: keccak output carries no
 * checksum, so lowercase already IS canonical for a txHash or an intentId.
 */
export function checksummed(address: string): Address {
  return isAddress(address, { strict: false }) ? getAddress(address) : (address as Address);
}

/**
 * Basis points → a percentage string: `50` → `"0.5%"`, `280` → `"2.8%"`.
 *
 * Exists so no surface hardcodes "0.5%" or "2.8%". Both rates are constants
 * (`GANTRY_FEE_BPS`, `CARD_FEE_BPS`) and the fee one is enforced on-chain — a
 * literal in markup is a number that can silently disagree with the contract.
 * Trailing zeros are trimmed so 100 bps reads "1%", not "1.0%".
 */
export function formatBps(bps: number): string {
  if (!Number.isFinite(bps)) throw new Error(`invalid bps: ${bps}`);
  return `${Number((bps / 100).toFixed(2))}%`;
}

export function basescanAddress(address: string): string {
  return `${BASESCAN_BASE_URL}/address/${address}`;
}

export function basescanTx(txHash: string): string {
  return `${BASESCAN_BASE_URL}/tx/${txHash}`;
}

export function basescanBlock(blockNumber: number | bigint): string {
  return `${BASESCAN_BASE_URL}/block/${blockNumber}`;
}
