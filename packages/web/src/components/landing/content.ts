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
/** The public directory. Every shop on the rail, in registration order. */
export const MERCHANTS_HREF = "/merchants";

export const GANTRY_FEE_LABEL = formatBps(GANTRY_FEE_BPS);
export const CARD_FEE_LABEL = formatBps(CARD_FEE_BPS);

export const IDEA = [
  { n: "01", text: "A payment is an intent: merchant M requests S$X." },
  {
    n: "02",
    text: "A QR code and an HTTP 402 are two encodings of that same intent, so one URL can be both.",
  },
  { n: "03", text: "One contract consumes both, so a hawker and an API get paid the same way." },
] as const;

/*
 * `WHY` lived here: three cards headed "Why this, and why here", covering
 * PayNow's tourist gap, the agent gap, and on-chain spend allowances. It was
 * removed when the coverage panel landed, because the first two said exactly
 * what the Euler diagram and the rail list say, about 400px apart on the same
 * page. The third had no equivalent and survives on the Gantry rail in
 * `coverage-diagram.tsx`, along with the x402 point from the second. Do not
 * reinstate this block without checking that the panel does not already say it.
 */

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
    body: "Categories carry no KYC, and the back-office has no login: anyone with the URL can read a shop's takings. Changing them is a different matter, and both writes are signed by the payout key.",
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
 * The factory, not a wallet. Any single wallet has one owner and is superseded
 * the moment a payer creates their own; the factory is what mints every one of
 * them. (The pinned `demoAgentPbmWallet` this note used to name is gone — the
 * 10 Aug 2026 redeploy left it enumerable by nothing and older than the wallet
 * ABI every screen reads.)
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
    name: "EURC",
    note: "The second payable currency, also Circle's own",
    address: BASE_SEPOLIA_ADDRESSES.realEurc,
  },
  {
    name: "MockXSGD",
    note: "The one mocked token, labelled everywhere it appears",
    address: BASE_SEPOLIA_ADDRESSES.mockXsgd,
  },
];
