import { BASE_SEPOLIA_CHAIN_ID } from "@gantry/shared";
import { Mono } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { GUTTER_X } from "./content";

export function LandingFooter() {
  return (
    <footer
      className={cn(
        "flex flex-col gap-3 border-t border-hairline-strong pt-7.5 pb-11 text-meta text-faint sm:flex-row sm:items-center sm:justify-between",
        GUTTER_X,
      )}
    >
      {/* Worded as narrowly as the facts allow. AIsa's gateway is where the
          agent REASONS and is not in the payment path; their own paid endpoints
          are not payable over x402 either, so "our agent pays them over x402" is
          the easy sentence and a false one. */}
      <div className="flex flex-col gap-1.5">
        <span>
          Gantry · a hackathon prototype. Production would operate with a licensed PSP under
          Singapore&apos;s Payment Services Act.
        </span>
        <span>
          Agent reasoning runs on <span className="text-muted">AIsa</span>&apos;s gateway. Every
          payment settles on Gantry&apos;s own rail.
        </span>
      </div>
      <Mono size="md" className="shrink-0">
        Base Sepolia · eip155:{BASE_SEPOLIA_CHAIN_ID}
      </Mono>
    </footer>
  );
}
