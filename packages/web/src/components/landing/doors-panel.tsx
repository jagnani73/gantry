import { BASE_SEPOLIA_ADDRESSES } from "@gantry/shared";
import { Card, Label, Mono } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { basescanAddress, GANTRY_FEE_LABEL, GUTTER_X, shortAddress } from "./content";

/**
 * One card per door, plus the contract both of them land in. All three are flex
 * columns with the footer pushed to the bottom, so the three mono lines sit on
 * one baseline however long the bodies run.
 */
function DoorCard({
  label,
  title,
  body,
  footer,
  light = false,
}: {
  label: string;
  title: string;
  body: React.ReactNode;
  footer: React.ReactNode;
  /** The third card inverts — it is the thing both doors converge on. */
  light?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-card p-7",
        light ? "bg-on-accent text-ink" : "bg-on-accent/8",
      )}
    >
      <Label tone={light ? "faint" : "on-accent-muted"}>{label}</Label>
      <div className="mt-3.5 text-title-lg">{title}</div>
      <p className={cn("mt-3 text-body-lg", light ? "text-quiet" : "text-on-accent-body")}>{body}</p>
      <div className="mt-auto pt-5">{footer}</div>
    </div>
  );
}

export function DoorsPanel() {
  return (
    <section id="how-it-works" className={cn("pb-20", GUTTER_X)}>
      {/* The header's "How it works" link lands here, so the section has to be
          titled the words the nav promised — otherwise the page jumps and
          nothing confirms the reader arrived. The eyebrow below is pitch copy
          for the card, not a heading; it is not a duplicate of this. */}
      <h2 className="text-section">How it works</h2>
      <Card tone="accent" radius="hero" pad="none" className="mt-6.5 p-7 md:px-14 md:py-13">
        <Label tone="on-accent-muted">Two doors, one settlement</Label>
        <div className="mt-8.5 grid grid-cols-1 gap-6 md:grid-cols-3">
          <DoorCard
            label="Human door"
            title="A printed QR code"
            body="Tourist scans, signs once, pays no gas. No app, no Singapore bank account."
            footer={
              <Mono size="xs" tone="on-accent-muted">
                EIP-3009 authorization
              </Mono>
            }
          />
          <DoorCard
            label="Agent door"
            title="An HTTP 402"
            body="Software pays inside on-chain limits its owner set. Agents can't open bank accounts."
            footer={
              <Mono size="xs" tone="on-accent-muted">
                x402 v2 · gantry-pbm
              </Mono>
            }
          />
          <DoorCard
            light
            label="Both settle through"
            title="One contract"
            body={`USDC or EURC in, swapped atomically. The merchant receives XSGD, minus ${GANTRY_FEE_LABEL}.`}
            footer={
              <a
                className="focus-ring rounded-badge text-faint transition-colors hover:text-accent"
                href={basescanAddress(BASE_SEPOLIA_ADDRESSES.gantryCore)}
                target="_blank"
                rel="noreferrer"
              >
                <Mono size="xs">
                  GantryCore {shortAddress(BASE_SEPOLIA_ADDRESSES.gantryCore)} ↗
                </Mono>
              </a>
            }
          />
        </div>

        {/* The doors above are drawn apart because they differ in trust; these
            two lines are here because they are where the separation collapses.
            One URL is literally both doors, and an agent can reach the rail
            without a human having chosen the shop first — neither claim fits
            inside a card that has to pick a single door to describe. */}
        <div className="mt-8.5 grid grid-cols-1 gap-x-14 gap-y-4 border-t border-on-accent/15 pt-7 md:grid-cols-2">
          <p className="text-body text-on-accent-body">
            <span className="text-on-accent">One URL serves both.</span>{" "}
            <Mono size="xs" tone="on-accent-muted">
              /pay/&lt;handle&gt;?sgd=
            </Mono>{" "}
            redirects a person into the payer app and answers a machine with the same 402.
          </p>
          <p className="text-body text-on-accent-body">
            <span className="text-on-accent">An agent can find the shop, too.</span>{" "}
            <Mono size="xs" tone="on-accent-muted">
              /discovery/resources
            </Mono>{" "}
            lists every registered merchant as a payable resource, so nobody has to pick one for it.
          </p>
        </div>
      </Card>
    </section>
  );
}
