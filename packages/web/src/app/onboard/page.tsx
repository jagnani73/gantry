import Link from "next/link";
import { OnboardClient } from "@/components/onboard-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Self-service onboarding is a demo affordance, not a public one — the backend
 * gates POST /api/merchants on the same NODE_ENV signal. Branching here rather
 * than inside the form means a deployed host never ships a working-looking form
 * that 403s on submit: the worst version of this is someone typing their stall
 * name and payout address before being told no.
 *
 * Server component, so `process.env.NODE_ENV` is the build's own value and the
 * decision is made before any HTML is sent. The form's client chunk is still
 * emitted on a production build — the import is unconditional and the RSC
 * boundary is drawn before dead-code elimination — but it is never mounted, so
 * the only cost is ~3 kB nobody downloads a second copy of. Do not read the
 * bundle size as evidence the gate leaked.
 */
const onboardingEnabled = process.env.NODE_ENV !== "production";

export default function OnboardPage() {
  if (onboardingEnabled) return <OnboardClient />;

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Onboarding is verified-merchant-only here</CardTitle>
          <CardDescription>
            Merchants are reviewed before they are added on this deployment, the way merchant
            acquiring works everywhere else. Self-service registration runs on the demo host.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>
            Registration itself is permissionless on-chain — <code>registerMerchant</code> on{" "}
            <code>GantryCore</code> is callable by anyone with gas. What is gated here is Gantry
            paying that gas for an unauthenticated caller.
          </p>
          <p>
            The merchants already registered are live: their QR codes take payments and their
            settlements land in the dashboard feed.
          </p>
          <div className="flex gap-2 pt-1">
            <Button asChild>
              <Link href="/dashboard">Open the dashboard</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/pay/ah-hock-chicken-rice">Pay a live merchant</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
