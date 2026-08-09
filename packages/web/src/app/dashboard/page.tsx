import { redirect } from "next/navigation";
import { resolveScope } from "@gantry/shared";
import {
  DEFAULT_SCREEN,
  DEMO_MERCHANT_HANDLE,
  merchantHref,
} from "@/components/merchant/screens";

/**
 * The old all-merchants dashboard, kept alive as a redirect.
 *
 * Nothing links here any more — the onboarding success card points at
 * `/merchant/<handle>/settlements` — but it is still typed from rehearsal
 * muscle memory, and both the README and the deck outline state that the path
 * redirects, so it has to keep landing somewhere sensible. `?handle=` was how
 * the old screen scoped itself to one shop; that is now the route, so the
 * parameter maps straight onto it.
 */
export default async function DashboardRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.handle;
  const scope = resolveScope(Array.isArray(raw) ? raw[0] : raw);
  redirect(merchantHref(scope ?? DEMO_MERCHANT_HANDLE, DEFAULT_SCREEN));
}
