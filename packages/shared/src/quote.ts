const ONE = 1_000_000n;

/**
 * Payer amount for a target XSGD price at a FixedRateSwap rate.
 * MUST ceil — a floored quote can swap to less than xsgdAmount and revert
 * InsufficientOutput (fuzz-proven in FixedRateSwap.t.sol).
 */
export function quoteAmountIn(xsgdAmount: bigint, rate: bigint): bigint {
  if (xsgdAmount <= 0n) throw new Error("xsgdAmount must be positive");
  if (rate <= 0n) throw new Error("rate must be positive");
  return (xsgdAmount * ONE + rate - 1n) / rate;
}

/** "6.50" → 6_500_000n (XSGD/SGD 6dp units). Accepts 0–6 decimal places. */
export function parseSgd(input: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!match) throw new Error(`invalid SGD amount: ${JSON.stringify(input)}`);
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  return whole * ONE + frac;
}

/** 6dp integer units → display string, default 2dp: 6_500_001n → "6.50". */
export function formatUnits6(units: bigint, displayDp = 2): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / ONE;
  const frac = (abs % ONE).toString().padStart(6, "0").slice(0, displayDp);
  const sign = neg ? "-" : "";
  return displayDp > 0 ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}
