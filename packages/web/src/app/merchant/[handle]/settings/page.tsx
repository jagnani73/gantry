import { SettingsScreen } from "@/components/merchant/settings-screen";

/**
 * Profile editing is a demo affordance, not a public one — the backend gates
 * PATCH /api/merchants/:handle on the same NODE_ENV signal that closes
 * self-service onboarding. The decision is made HERE rather than inside the
 * screen, for the reason `/onboard` already documents: a deployed host must
 * never ship a working-looking form that 403s on submit, and the worst version
 * of that is a merchant rewriting their shop name and losing it to an error
 * toast.
 *
 * Server component, so `process.env.NODE_ENV` is the build's own value and the
 * editable form is never sent. Unlike `/onboard` the screen is not replaced —
 * a shop's own settings should still show what the chain holds — so the fields
 * render locked beside the two that are locked for good (handle, category) and
 * the save controls become an explanation.
 */
const profileEditingEnabled = process.env.NODE_ENV !== "production";

export default function MerchantSettingsPage() {
  return <SettingsScreen editable={profileEditingEnabled} />;
}
