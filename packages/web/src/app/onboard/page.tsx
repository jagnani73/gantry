import Link from "next/link";
import { Card, Label, Mono } from "@/components/primitives";
import { OnboardClient } from "@/components/onboard-client";

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

/** Where a turned-away visitor is sent. The one merchant that is always live. */
const DEMO_HANDLE = "ah-hock-chicken-rice";

export default function OnboardPage() {
  if (onboardingEnabled) return <OnboardClient />;

  return (
    <main className="mx-auto max-w-[720px] px-5 py-14 sm:px-10">
      <Label size="eyebrow">For shops</Label>
      <h1 className="mt-3 text-page-title">Onboarding is verified-merchant-only here</h1>
      <p className="mt-2.5 text-body text-quiet">
        Merchants are reviewed before they are added on this deployment, the way merchant
        acquiring works everywhere else. Self-service registration runs on the demo host.
      </p>

      <Card pad="lg" className="mt-8 flex flex-col gap-4">
        <p className="text-body text-quiet">
          Registration itself is permissionless on-chain — <Mono tone="ink">registerMerchant</Mono>{" "}
          on <Mono tone="ink">GantryCore</Mono> is callable by anyone with gas. What is gated here
          is Gantry paying that gas for an unauthenticated caller.
        </p>
        <p className="text-body text-quiet">
          The merchants already registered are live: their codes take payments and their
          settlements land in the feed as they happen.
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          <Link
            href={`/merchant/${DEMO_HANDLE}/settlements`}
            className="focus-ring inline-flex items-center justify-center rounded-control bg-ink px-4.5 py-3 text-btn-sm text-paper transition-colors hover:bg-ink-hover"
          >
            Open a live shop →
          </Link>
          <Link
            href={`/pay/${DEMO_HANDLE}`}
            className="focus-ring inline-flex items-center justify-center rounded-control bg-fill-subtle px-4.5 py-3 text-btn-sm font-medium text-quiet transition-colors hover:bg-fill-hover-strong"
          >
            Pay a live merchant
          </Link>
        </div>
      </Card>

      <footer className="mt-10 text-meta text-faint">
        <Link className="focus-ring" href="/">
          ← Overview
        </Link>
      </footer>
    </main>
  );
}
