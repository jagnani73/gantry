/**
 * One `cn`, re-exported so the barrel and `@/lib/utils` cannot drift into two
 * different merge configurations — which would make a font size survive or
 * vanish depending on which import path a file happened to use.
 */
export { cn } from "@/lib/utils";
