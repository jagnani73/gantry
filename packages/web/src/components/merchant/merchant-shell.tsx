"use client";

import Link from "next/link";
import { Card } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { MerchantProvider, useMerchantContext } from "./merchant-context";
import { MerchantSidebar } from "./merchant-sidebar";
import { TransactionDrawer } from "./transaction-drawer";

/**
 * The merchant back-office frame: a nav column of fixed WIDTH — a 248px grid
 * track, not `position: fixed` — and one screen beside it.
 *
 * There is NO merchant login anywhere in Gantry — anyone with the URL can read
 * any shop's back-office. That is on the honest-labels list and is deliberately
 * not papered over here with a sign-in that checks nothing.
 */
export function MerchantShell({ handle, children }: { handle: string; children: React.ReactNode }) {
  return (
    <MerchantProvider handle={handle}>
      {/* `print:block` matters: the sidebar hides itself when printing, and a
          two-column grid would otherwise keep holding 248px open beside the
          standee. */}
      <div className="grid min-h-dvh grid-cols-1 min-[1100px]:grid-cols-[248px_1fr] print:block">
        <MerchantSidebar />
        <MerchantMain>{children}</MerchantMain>
      </div>
      <TransactionDrawer />
    </MerchantProvider>
  );
}

/**
 * Screens only mount once the shop is known. Every one of them names the shop,
 * its payout address or its category somewhere, and a screen that renders those
 * as blanks first and fills them in a beat later reads as broken rather than as
 * loading.
 */
function MerchantMain({ children }: { children: React.ReactNode }) {
  const { status } = useMerchantContext();
  return (
    <main className="flex min-w-0 flex-col gap-5 p-8 pb-12 print:p-0">
      {status === "ready" ? children : <MerchantGate />}
    </main>
  );
}

function MerchantGate() {
  const { handle, status, error, reload } = useMerchantContext();

  if (status === "loading") {
    return (
      <Card radius="card" pad="lg" className="text-body text-muted">
        Loading <span className="font-mono">@{handle}</span> from the chain…
      </Card>
    );
  }

  if (status === "missing") {
    return (
      <Card radius="card" pad="lg" className="max-w-xl">
        <h1 className="text-title-lg">No shop registered here</h1>
        <p className="mt-2.5 text-body text-quiet">
          <span className="font-mono">@{handle}</span> is not in GantryCore&apos;s merchant
          registry, so there is nothing to show. Handles are claimed on-chain and the claim is
          permanent. If this is your shop, it was registered under a different one.
        </p>
        <Button asChild className="mt-5">
          <Link href="/onboard">Register a shop →</Link>
        </Button>
      </Card>
    );
  }

  return (
    <Card radius="card" pad="lg" className="max-w-xl">
      <h1 className="text-title-lg">Can&apos;t reach the backend</h1>
      <p className="mt-2.5 text-body text-quiet">
        The merchant record is read live from GantryCore through the Gantry API, and that request
        did not come back. Payments are unaffected. They settle on-chain whether or not this
        screen can see them.
      </p>
      {error ? <p className="mt-3 font-mono text-mono-sm break-all text-faint">{error}</p> : null}
      <Button type="button" onClick={reload} className="mt-5">
        Try again
      </Button>
    </Card>
  );
}
