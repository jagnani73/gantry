import { Mono } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { basescanAddress, CONTRACTS, GUTTER_X, shortAddress } from "./content";

/**
 * The deployed addresses, on their own.
 *
 * This used to share a two-column grid with a "Why this, and why here" column,
 * which meant a heading sat beside unrelated content and neither owned the row.
 * Standing alone, it can be a plain full-width section, which is also why the
 * subgrid that used to align the two headings is gone: there is no second
 * heading left to align to.
 *
 * Tiles rather than a single stack of rows. Full width, a five-row table puts a
 * shop's worth of empty space between each name and its address; a three-track
 * grid keeps name, note and address inside one readable block and matches the
 * seams grid directly below it.
 */
export function ContractsSection() {
  return (
    <section id="contracts" className={cn("pb-20", GUTTER_X)}>
      <h2 className="text-section">Contracts</h2>
      <p className="mt-2 text-body text-muted">Deployed and verified on Base Sepolia</p>

      <div className="mt-6.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {CONTRACTS.map((contract) => (
          <a
            key={contract.address}
            className="focus-ring rounded-control-m bg-surface px-6 py-5 transition-colors hover:bg-fill-hover-card"
            href={basescanAddress(contract.address)}
            target="_blank"
            rel="noreferrer"
          >
            <div className="text-card-title-sm">{contract.name}</div>
            <div className="mt-1 text-meta-sm text-faint">{contract.note}</div>
            <Mono className="mt-3 block whitespace-nowrap text-accent">
              {shortAddress(contract.address)} ↗
            </Mono>
          </a>
        ))}
      </div>
    </section>
  );
}
