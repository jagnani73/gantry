import { DoorsPanel } from "@/components/landing/doors-panel";
import { EntryCards } from "@/components/landing/entry-cards";
import { EvidenceSection } from "@/components/landing/evidence-section";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";
import { LandingHero } from "@/components/landing/landing-hero";

/**
 * The pitch page, and the only place that links to both product surfaces.
 *
 * Static: every fact on it comes from `@gantry/shared` at build time, so it has
 * no client bundle and renders even when the backend is asleep on a free tier.
 * Drawn at 1440 and capped there — wider monitors centre it rather than stretch
 * a 52ch standfirst across two feet of glass.
 */
export default function Home() {
  return (
    <main className="mx-auto max-w-[1440px]">
      <LandingHeader />
      <LandingHero />
      <DoorsPanel />
      <EvidenceSection />
      <EntryCards />
      <LandingFooter />
    </main>
  );
}
