import { formatUnits6 } from "@gantry/shared";

/**
 * A token amount as it travels on the wire: 6dp integer units.
 *
 * `number` is deliberately not in the union. Money that has been through a float
 * is money that can be wrong by a unit, and the whole stack — contracts, backend,
 * shared — speaks 6dp integer decimal strings end to end.
 */
export type Units = bigint | string;

/**
 * Throws rather than coercing. A non-integer string here is always an upstream
 * bug (someone formatted before rendering, or did arithmetic in JS), and this
 * project would rather blow up in dev than paint a number nobody can reconcile
 * against the chain.
 */
export function toUnits(units: Units): bigint {
  if (typeof units === "bigint") return units;
  const trimmed = units.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new TypeError(`expected 6dp integer units, received ${JSON.stringify(units)}`);
  }
  return BigInt(trimmed);
}

/** 6dp units → display string. The single formatting path for every primitive. */
export function formatUnits(units: Units, dp = 2): string {
  return formatUnits6(toUnits(units), dp);
}

/**
 * Fraction of `cap` already spent, 0–100, for meters only.
 *
 * The division happens in bigint and only the resulting *ratio* becomes a number,
 * so no amount is ever a float — the widths of a 5px bar do not need more than
 * two decimal places of precision.
 */
export function percentOf(spent: Units, cap: Units): number {
  const capUnits = toUnits(cap);
  if (capUnits <= 0n) return 0;
  const spentUnits = toUnits(spent);
  if (spentUnits <= 0n) return 0;
  const basisPoints = (spentUnits * 10_000n) / capUnits;
  return Math.min(100, Number(basisPoints) / 100);
}
