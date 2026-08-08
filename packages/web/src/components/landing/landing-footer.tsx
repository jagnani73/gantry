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
      <span>
        Gantry · a hackathon prototype. Production would operate with a licensed PSP under
        Singapore&apos;s Payment Services Act.
      </span>
      <Mono size="md" className="shrink-0">
        Base Sepolia · eip155:{BASE_SEPOLIA_CHAIN_ID}
      </Mono>
    </footer>
  );
}
