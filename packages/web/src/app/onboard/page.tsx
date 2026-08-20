import { OnboardClient } from "@/components/onboard-client";

/**
 * Self-service onboarding, open on every host since 20 Aug 2026.
 *
 * This page used to branch on `process.env.NODE_ENV` in the server component, so
 * a production build never emitted the form at all. The reasoning was that
 * registering spends the relayer's gas key and draining it stops every door in
 * the system — but on Base Sepolia that is faucet ETH and ~180k gas, and a rail
 * nobody outside the demo can join demonstrates the opposite of a permissionless
 * registry. `registerMerchant` needs no permission from us on-chain; a door that
 * said otherwise off-chain was telling a story the contract does not.
 *
 * What actually needed bounding is that a registration is PERMANENT and its text
 * renders on `/merchants`. That is now a global rolling-24h ceiling in the
 * backend (`PUBLIC_REGISTER_DAILY`), which holds regardless of how many IPs a
 * caller has — the per-IP cooldown never could — plus an `ONBOARDING=closed`
 * kill switch for responding to abuse without a deploy.
 *
 * So the gate is DYNAMIC now, and a build-time branch can no longer express it.
 * The old "registration is off here" screen went with it rather than being left
 * unreachable. Both refusals — the kill switch and the ceiling — arrive as an
 * API error the form renders inline, with its own sentence, which is what any
 * rate-limited endpoint does. The principle that produced the old branch (never
 * ship a form that 403s after someone has typed their payout address) was about
 * a permanently closed door on a deployed host; it does not extend to an
 * incident switch that is off by default.
 */
export default function OnboardPage() {
  return <OnboardClient />;
}
