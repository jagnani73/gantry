import {
  BASE_SEPOLIA_ADDRESSES,
  CARD_FEE_BPS,
  DEMO_MERCHANT_HANDLE,
  GANTRY_FEE_BPS,
  basescanAddress,
  formatBps,
  shortAddress,
} from "@gantry/shared";
import type { Address } from "viem";

export { basescanAddress, shortAddress };

/**
 * The landing page's copy and the facts it cites, in one place.
 *
 * Everything the chain owns — addresses, explorer URLs, fee rates — is derived
 * here rather than typed into markup. The prototype hardcoded truncated display
 * strings (`0x6F02…5Ce0`), which survive a redeploy looking perfectly correct.
 */

/** Section gutter. 1440 is the drawn width; below it the page keeps breathing room. */
export const GUTTER_X = "px-5 sm:px-10 lg:px-16";

export const REPO_URL = "https://github.com/jagnani73/gantry";

/** The merchant surface the two "for shops" entries open. */
export const DEMO_HANDLE = DEMO_MERCHANT_HANDLE;
export const MERCHANT_HREF = `/merchant/${DEMO_HANDLE}/overview`;
export const PAYER_HREF = "/app";

export const GANTRY_FEE_LABEL = formatBps(GANTRY_FEE_BPS);
export const CARD_FEE_LABEL = formatBps(CARD_FEE_BPS);

export const IDEA = [
  { n: "01", text: "A payment is an intent: merchant M requests S$X." },
  { n: "02", text: "A QR code and an HTTP 402 response are two encodings of that same intent." },
  { n: "03", text: "One contract consumes both, so a hawker and an API get paid the same way." },
] as const;

export const WHY = [
  {
    title: "PayNow needs a Singapore bank account",
    // "Benchmarked here" rather than a flat "cards cost 2.8%": CARD_FEE_BPS is
    // this project's comparison rate, not a claim about the card industry.
    body: `The ~16M visitors who arrive each year have none. They fall back to cards (benchmarked here at ${CARD_FEE_LABEL} in merchant fees) or to cash.`,
  },
  {
    title: "AI agents can't open bank accounts at all",
    body: "x402 gives them a standard way to pay. Gantry gives them somewhere to spend it.",
  },
  {
    title: "Agent spending stays inside on-chain allowances",
    body: "Daily caps, category allowlists, expiry: Purpose-Bound Money, applied to software. Denials are contract reverts, not backend checks.",
  },
] as const;

/**
 * The seams, named individually rather than as one paragraph.
 *
 * This was a single block of prose set in two CSS columns to fill the panel's
 * width. It read as nonsense: the columns were only three lines tall, so the eye
 * carried straight across the gap and joined "XSGD exists on no testnet.
 * Payments" to "for real liquidity. One trusted relayer key…". Short wide
 * columns are the one shape multi-column text cannot take.
 *
 * Discrete items also serve the purpose better. A judge discounting a demo that
 * claims everything is real can now count the seams instead of parsing them, and
 * nothing here can be skimmed past.
 */
export const SEAMS = [
  {
    title: "XSGD is a mock",
    body: "MockXSGD is the only mocked token in the system, and it has to be: XSGD exists on no testnet.",
  },
  {
    title: "The FX rate is owner-set",
    body: "One address sets it, and nothing arbitrages it. The interface it sits behind is built to be swapped for real liquidity.",
  },
  {
    title: "One key does everything",
    body: "A single trusted relayer pays every gas fee and runs the facilitator.",
  },
  {
    title: "Merchants are self-attested",
    body: "Categories carry no KYC, and the back-office has no login. Anyone with the URL can read a shop's takings.",
  },
  {
    title: "There is no off-ramp",
    body: "Payouts stay in XSGD on a testnet. Nothing here reaches a bank account.",
  },
] as const;

export interface ContractRow {
  name: string;
  note: string;
  address: Address;
}

/**
 * The factory, not the demo wallet. `demoAgentPbmWallet` is one wallet with one
 * owner and it is being superseded by payer-created wallets; the factory is what
 * mints every one of them and does not go stale.
 */
export const CONTRACTS: ContractRow[] = [
  {
    name: "GantryCore",
    note: "Merchant registry, intents, dual-door settlement",
    address: BASE_SEPOLIA_ADDRESSES.gantryCore,
  },
  {
    name: "AgentPBMWalletFactory",
    note: "Mints an agent's on-chain spend policy wallet",
    address: BASE_SEPOLIA_ADDRESSES.agentPbmFactory,
  },
  {
    name: "FixedRateSwap",
    note: "Stablecoin in → XSGD out, behind IGantrySwap",
    address: BASE_SEPOLIA_ADDRESSES.fixedRateSwap,
  },
  {
    name: "USDC",
    note: "Circle's real testnet contract: payers sign against it",
    address: BASE_SEPOLIA_ADDRESSES.realUsdc,
  },
  {
    name: "MockXSGD",
    note: "The one mocked token, labelled everywhere it appears",
    address: BASE_SEPOLIA_ADDRESSES.mockXsgd,
  },
];
