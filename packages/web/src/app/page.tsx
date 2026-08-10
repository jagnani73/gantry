import { ContractsSection } from "@/components/landing/contracts-section";
import { DoorsPanel } from "@/components/landing/doors-panel";
import { EntryCards } from "@/components/landing/entry-cards";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";
import { LandingHero } from "@/components/landing/landing-hero";
import { ProofSection } from "@/components/landing/proof-section";
import { SeamsSection } from "@/components/landing/seams-section";

/**
 * The pitch page, and the only place that links to both product surfaces.
 *
 * Static: every fact on it comes from `@gantry/shared` at build time, so it has
 * no client bundle and renders even when the backend is asleep on a free tier.
 * Drawn at 1440 and capped there — wider monitors centre it rather than stretch
 * a 52ch standfirst across two feet of glass.
 *
 * Section order is the argument's order: what it is, then how it works, then who
 * it reaches (the thesis, and the heaviest section), then the evidence, then the
 * disclosure. The seams go LAST on purpose — the page ends on what isn't real
 * rather than burying it mid-scroll, and from there the only thing left is the
 * two doors into the product.
 */
export default function Home() {
  return (
    <main className="mx-auto max-w-[1440px]">
      <LandingHeader />
      <LandingHero />
      <DoorsPanel />
      <ProofSection />
      <ContractsSection />
      <SeamsSection />
      <EntryCards />
      <LandingFooter />
    </main>
  );
}
