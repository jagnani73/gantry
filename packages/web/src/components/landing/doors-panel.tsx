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
      <Card tone="accent" radius="hero" pad="none" className="p-7 md:px-14 md:py-13">
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
            body={`Whatever stablecoin arrived is swapped atomically. The merchant receives XSGD, minus ${GANTRY_FEE_LABEL}.`}
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
      </Card>
    </section>
  );
}
