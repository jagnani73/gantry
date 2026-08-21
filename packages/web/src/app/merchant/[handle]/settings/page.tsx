import { SettingsScreen } from "@/components/merchant/settings-screen";

/**
 * Profile editing is open on every host since 21 Aug 2026, alongside
 * self-service registration.
 *
 * This page used to branch on `process.env.NODE_ENV` in the server component, so
 * a production build shipped the fields permanently locked. The argument was
 * that the route was unauthenticated and anyone with the URL could rewrite a
 * shop's identity. That is no longer true: since 21 Aug an edit carries an
 * EIP-712 signature from the shop's payout address, which the backend checks
 * against a fresh registry read before relaying anything. The per-handle and
 * per-IP cooldowns and the rolling-24h ceiling stay underneath as a gas bound,
 * with `PROFILE_EDITS=closed` as the incident switch.
 *
 * `SettingsScreen` still takes an `editable` prop and nothing passes `false`,
 * but its locked variants are NOT unreachable any more and this docblock said
 * they were: `canEdit = editable && owns`, so every visitor without the payout
 * key sees them. That is now the common case rather than a landing pad. The prop
 * survives for a future server-side read of `PROFILE_EDITS`, which nothing reads
 * client-side today and which still surfaces as a 403 on submit.
 *
 * `handle` and `category` remain locked for good and for their own reasons: the
 * handle is claimed permanently, and `GantryCore` has no setter for a category.
 * Those two are the screen's business, not this file's.
 */
export default function MerchantSettingsPage() {
  return <SettingsScreen editable />;
}
