import type { Metadata } from "next";
import { resolveScope } from "@gantry/shared";
import { MerchantShell } from "@/components/merchant/merchant-shell";

/** Handles are lowercase on-chain, so a shared or hand-typed `/merchant/Ah-Hock`
 * should reach the same shop rather than silently show an empty back-office. */
function normalize(handle: string): string {
  return resolveScope(handle) ?? handle;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  return { title: `@${normalize(handle)} · Gantry` };
}

export default async function MerchantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return <MerchantShell handle={normalize(handle)}>{children}</MerchantShell>;
}
