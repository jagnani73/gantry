import { redirect } from "next/navigation";
import { DEFAULT_SCREEN, merchantHref } from "@/components/merchant/screens";

/** `/merchant/<handle>` is not a screen — the back-office opens on settlements. */
export default async function MerchantIndexPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  redirect(merchantHref(handle, DEFAULT_SCREEN));
}
