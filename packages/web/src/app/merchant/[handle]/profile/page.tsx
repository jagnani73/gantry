import { redirect } from "next/navigation";
import { resolveScope } from "@gantry/shared";
import { merchantHref } from "@/components/merchant/screens";

/**
 * Shop profile folded into Settings, kept alive as a redirect.
 *
 * The identity form was the substantive half of both screens, so it survived the
 * merge intact — only its address changed. Nothing links here any more, but the
 * path was linkable by design (screens are routes precisely so they can be sent
 * to someone), and a merchant who bookmarked their own profile should land on
 * the form rather than on a 404.
 */
export default async function MerchantProfileRedirectPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  redirect(merchantHref(resolveScope(handle) ?? handle, "settings"));
}
