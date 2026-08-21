import { SettingsScreen } from "@/components/merchant/settings-screen";

/**
 * Profile editing is open on every host since 21 Aug 2026, alongside
 * self-service registration.
 *
 * This page used to branch on `process.env.NODE_ENV` in the server component, so
 * a production build shipped the fields permanently locked. The argument was
 * that the route is unauthenticated and anyone with the URL could rewrite a
 * shop's identity — true, and weaker than it sounds: `setMerchantProfile`
 * provably cannot touch payout, handle or category, so an edit moves no money
 * and redirects no payment, and unlike a registration it is REVERSIBLE, because
 * the real merchant corrects it through the same open route. Defacement, not
 * theft, and self-healing.
 *
 * The backend bounds it with a per-HANDLE cooldown (the shape defacement
 * actually takes — one shop, repeatedly), a per-IP cooldown, and a global
 * rolling-24h ceiling, with `PROFILE_EDITS=closed` as the incident switch. That
 * gate is dynamic, so a build-time branch can no longer express it.
 *
 * `SettingsScreen` still takes an `editable` prop and nothing passes `false` any
 * more, so its locked variants are currently UNREACHABLE — including under
 * `PROFILE_EDITS=closed`, which nothing reads client-side and which surfaces as
 * a 403 on submit, the way any rate-limited endpoint refuses. Kept rather than
 * deleted so a future server-side read of that switch has somewhere to land; do
 * not read the prop as evidence a locked state is reachable today.
 *
 * `handle` and `category` remain locked for good and for their own reasons: the
 * handle is claimed permanently, and `GantryCore` has no setter for a category.
 * Those two are the screen's business, not this file's.
 */
export default function MerchantSettingsPage() {
  return <SettingsScreen editable />;
}
