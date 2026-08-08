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
 * It is linked from the onboarding success card, from `demo-reset`'s printout
 * and from a year of rehearsal muscle memory, so it has to keep landing
 * somewhere sensible. `?handle=` was how the old screen scoped itself to one
 * shop; that is now the route, so the parameter maps straight onto it.
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
