/**
 * The pure guards on the faucet's ETH leg, split out for the same reason
 * faucet-budget.ts is: faucet.ts cannot be imported without a chain, and these
 * two rules are what keep an unauthenticated route away from the only gas key
 * in the system.
 */

/**
 * How much ETH to send so `balance` reaches `target` — zero when it already
 * does.
 *
 * A TOP-UP, never a per-call grant. A flat grant would let one payer walk the
 * relayer's ETH away a tap at a time (a reload, a second device, a loop), and
 * top-up shape is also what makes an unconfirmable send self-correcting: if the
 * transaction we could not prove did land, the next call reads the higher
 * balance and sends nothing at all.
 */
export function gasTopUpAmount(balance: bigint, target: bigint): bigint {
  return balance >= target ? 0n : target - balance;
}

/**
 * Whether the funder may send `amount` and still hold `reserve` afterwards.
 *
 * The relayer's ETH is not one affordance's budget — it is the ONLY gas key, and
 * it pays for QR settlement, x402 settlement, intent creation and merchant
 * registration alike. Draining it does not degrade the demo, it stops every door
 * at once. So the guard is a floor on what is LEFT rather than a ceiling on what
 * a single call may spend; the ceiling is the rolling budget, and these bound
 * different failure modes.
 */
export function funderCanSend(funderBalance: bigint, amount: bigint, reserve: bigint): boolean {
  return funderBalance >= amount + reserve;
}
