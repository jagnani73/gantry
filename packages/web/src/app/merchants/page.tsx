import { Suspense } from "react";
import type { Metadata } from "next";
import { Card } from "@/components/primitives";
import { GUTTER_X } from "@/components/landing/content";
import { cn } from "@/lib/utils";
import { DirectoryFooter, DirectoryHeader } from "@/components/directory/directory-chrome";
import { MerchantDirectory } from "@/components/directory/directory-client";

export const metadata: Metadata = {
  title: "Merchants · Gantry",
  description:
    "Every shop registered on the Gantry rail. Each one claimed a handle on-chain and set the address its money goes to.",
};

/**
 * The public merchant directory.
 *
 * A shell, because the page reads `?q=`, `?category=` and `?shop=` — and
 * `useSearchParams` needs a Suspense boundary above it or the whole route opts
 * out of static rendering.
 *
 * The fallback is not optional decoration. Everything below the boundary is
 * excluded from the prerender, so WITHOUT one the HTML this route ships is empty
 * — no wordmark, no headline, nothing — until the bundle downloads and hydrates.
 * On the venue hotspot this is most likely to be opened over, that reads as a
 * broken link rather than a loading page. So the fallback paints the chrome the
 * client is about to paint anyway, and the same loading card, which makes
 * hydration a swap of one line of text rather than the page appearing.
 */
export default function MerchantsPage() {
  return (
    <Suspense fallback={<DirectorySkeleton />}>
      <MerchantDirectory />
    </Suspense>
  );
}

function DirectorySkeleton() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[1440px] flex-col">
      <DirectoryHeader />
      <section className={cn("grow pt-12 pb-22 lg:pt-17", GUTTER_X)}>
        <h1 className="text-section max-w-[18ch] min-[640px]:text-figure-sm min-[1100px]:text-hero-sm">
          Every shop on the rail.
        </h1>
        <Card radius="card-m" pad="lg" className="mt-10 text-body text-muted">
          Reading the merchant registry from the chain…
        </Card>
      </section>
      <DirectoryFooter />
    </main>
  );
}
