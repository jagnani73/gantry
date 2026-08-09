import { Card, Label, Mono, StatusDot } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { GUTTER_X, IDEA, MERCHANT_HREF, PAYER_HREF } from "./content";
import { LinkButton } from "./link-button";

export function LandingHero() {
  return (
    <section
      className={cn(
        "grid grid-cols-1 items-start gap-10 pt-14 pb-14 lg:grid-cols-[1fr_452px] lg:gap-18 lg:pt-22 lg:pb-18",
        GUTTER_X,
      )}
    >
      <div>
        <div className="inline-flex items-center gap-2.25 rounded-full bg-accent-tint px-3.25 py-1.5 text-meta-sm font-medium text-accent">
          <StatusDot tone="accent" />
          Live on Base Sepolia · NTU InnovateX 2026
        </div>

        {/* 76px is drawn at 1440. It survives down to ~768px inside 14ch; below
            that it stops being a headline and starts being a wall of letters. */}
        <h1 className="mt-6.5 max-w-[14ch] text-section md:text-hero">One rail, every payer.</h1>

        <p className="mt-6.5 max-w-[52ch] text-standfirst text-pretty text-quiet">
          A merchant integrates once and gets paid by anyone: a person scanning a printed QR, or an
          AI agent paying over x402. Both are the same on-chain payment intent. The shop always
          receives XSGD.
        </p>

        <div className="mt-10 flex flex-wrap gap-3">
          <LinkButton href={MERCHANT_HREF}>Open the merchant app →</LinkButton>
          <LinkButton href={PAYER_HREF} variant="surface">
            Open the payer app →
          </LinkButton>
        </div>
        <p className="mt-4 text-meta text-faint">
          Two separate surfaces. Neither one navigates into the other.
        </p>
      </div>

      <Card radius="panel" pad="none" className="p-7.5">
        <Label>The idea in three lines</Label>
        <ol className="mt-5.5 flex flex-col gap-5">
          {IDEA.map((item) => (
            <li key={item.n} className="flex gap-4">
              <Mono tone="accent" className="pt-0.75">
                {item.n}
              </Mono>
              <p className="text-body-lg text-ink">{item.text}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6.5 border-t border-hairline pt-5.5 text-meta text-muted">
          Track 1: Payments &amp; Financial Infrastructure. Contracts deployed and verified; x402
          traffic an unmodified client pays.
        </p>
      </Card>
    </section>
  );
}
