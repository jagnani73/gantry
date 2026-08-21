import { keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import {
  categoryName,
  gantryCoreAbi,
  isKnownCategory,
  isValidHandle,
  normalizePayout,
  type MerchantListResponse,
  type MerchantResponse,
  type RegisterMerchantRequest,
  type RegisterMerchantResponse,
  type UpdateMerchantProfileRequest,
  decodeGantryError,
} from "@gantry/shared";
import { publicClient } from "../chain";
import { config } from "../config";
import { countMerchants, getMerchantRow, insertMerchant, listMerchants } from "../db";
import { ApiError } from "../errors";
import { indexerStatus } from "../indexer";
import { sendRelayerTx } from "../relayer";
import { emptyBudget, msUntilReset, release, reserve } from "./faucet-budget";
import { emptyHandleBudgets, releaseForHandle, reserveForHandle } from "./handle-budget";
import {
  normalizeProfile,
  resolveProfile,
  toMerchantSummary,
  type MerchantProfile,
} from "./merchants-core";

/** What the registry itself stores. */
interface ChainMerchant {
  payout: Address;
  categoryId: number;
  /** On-chain since 11 Aug 2026. Was a SQLite row, which made the cache the only
   * source for something the chain could not re-supply — so two hosts reading the
   * same chain showed different shop names. */
  displayName: string;
  location: string;
  blurb: string;
}

/**
 * CHAIN facts only. The profile is a local SQLite read and the registration date
 * never changes, so neither belongs behind this TTL: caching the COMPOSED
 * response would hide a merchant's own edit from them for a minute after they
 * pressed Save.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: ChainMerchant }>();

export function merchantId(handle: string): Hex {
  return keccak256(toBytes(handle));
}

export async function getMerchant(handle: string): Promise<MerchantResponse> {
  if (!isValidHandle(handle)) {
    throw new ApiError(400, "InvalidHandle", `not a valid merchant handle: ${handle}`);
  }
  const id = merchantId(handle);
  const chain = await readMerchant(handle, id);
  return compose(handle, id, chain, registeredAtOf(handle));
}

/**
 * The public directory: every merchant the index holds, oldest first.
 *
 * Served entirely from the swept table with no chain read at all — which is what
 * makes it affordable and what makes two hosts agree. `GantryCore` has no
 * enumeration (a `mapping(bytes32 => Merchant)` and nothing else), so the logs
 * ARE the only census; they are also a complete one, because merchants are never
 * deleted.
 *
 * Sorted by registration and nothing else. Any other order would be a ranking,
 * and this list exists to say Gantry ranks nobody — a directory that ordered
 * shops by takings or by activity is the curation the footer note disclaims.
 *
 * Rows the sweep has not reached yet are simply absent, which is honest only as
 * far as the number beside them: `indexer` travels with the list so an empty one
 * can say whether the RAIL is empty or merely this host's view of it. Without
 * that the page asserts "No shops registered yet" on a cold backfill, which is a
 * false claim about the chain rather than a slow one.
 */
export function listMerchantIndex(): MerchantListResponse {
  const status = indexerStatus();
  return {
    merchants: listMerchants().map(toMerchantSummary),
    total: countMerchants(),
    indexer: { cursor: status.cursor, lag: status.lag },
  };
}

/**
 * The registry entry straight off the chain, bypassing the TTL cache.
 *
 * Used wherever an answer has to be a CHAIN fact rather than a recent one:
 * proving what a write actually did, and proving a registration landed. Returns
 * null for an unregistered handle instead of throwing, because both callers are
 * asking a question whose "no" is an ordinary answer.
 */
async function readMerchantFresh(id: Hex): Promise<ChainMerchant | null> {
  const [payout, categoryId, , displayName, location, blurb] = (await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "merchants",
    args: [id],
  })) as readonly [Address, number, string, string, string, string];
  if (payout === zeroAddress) return null;
  return { payout, categoryId, displayName, location, blurb };
}

function sameProfile(a: MerchantProfile, b: MerchantProfile): boolean {
  return a.displayName === b.displayName && a.location === b.location && a.blurb === b.blurb;
}

async function readMerchant(handle: string, id: Hex): Promise<ChainMerchant> {
  const cached = cache.get(handle);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const [payout, categoryId, , displayName, location, blurb] = (await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "merchants",
    args: [id],
  })) as readonly [Address, number, string, string, string, string];

  if (payout === zeroAddress) {
    throw new ApiError(404, "MerchantNotFound", `no merchant registered for handle: ${handle}`);
  }

  const value: ChainMerchant = { payout, categoryId, displayName, location, blurb };
  cache.set(handle, { at: Date.now(), value });
  return value;
}

function compose(
  handle: string,
  id: Hex,
  chain: ChainMerchant,
  registeredAt: number | undefined,
): MerchantResponse {
  return {
    handle,
    merchantId: id,
    payout: chain.payout,
    categoryId: chain.categoryId,
    categoryName: categoryName(chain.categoryId),
    ...resolveProfile(chain),
    ...(registeredAt === undefined ? {} : { registeredAt }),
  };
}

/**
 * The registration date, straight off the swept `merchants` table.
 *
 * A local SQLite read, so it costs nothing and EVERY caller gets it — including
 * the payment path, which the old implementation had to be kept away from.
 *
 * What this replaced was a second log walk run by this file alone: 24 getLogs
 * windows a pass on a 30s cooldown, resumable, amortised, and covering exactly
 * the block range the indexer sweep already covers — with its answers in a Map
 * that every restart threw away. Folding `MerchantRegistered` into that sweep
 * made all of it redundant: there it costs no extra RPC calls (the pass reads
 * the core's address regardless) and the answer persists.
 *
 * `undefined` means "the sweep has not reached that block yet", never "no such
 * merchant" — the chain read decides that. It renders as nothing; an estimate
 * would be worse, since this is the fact a shop would cite as proof it existed.
 */
function registeredAtOf(handle: string): number | undefined {
  return getMerchantRow(handle)?.block_time;
}

/**
 * The block a fresh registration mined in IS its registration date, so writing
 * the row here spares a shop that just onboarded from waiting up to 15s for the
 * sweep to tell it when it registered.
 *
 * The same row the indexer writes, from the same chain, learned from a receipt
 * instead of a log — and `insertMerchant` is INSERT OR IGNORE, so whichever
 * arrives first wins and the other is a no-op. Never awaited: the merchant's
 * response must not wait on it, and a failure only leaves the sweep to do it.
 */
function primeRegistration(
  handle: string,
  categoryId: number,
  profile: MerchantProfile,
  blockNumber: bigint,
): void {
  void publicClient
    .getBlock({ blockNumber })
    .then((block) =>
      insertMerchant({
        merchant_id: merchantId(handle),
        handle,
        category_id: categoryId,
        display_name: profile.displayName,
        location: profile.location,
        blurb: profile.blurb,
        block_number: Number(blockNumber),
        block_time: Number(block.timestamp),
      }),
    )
    .catch((err) => console.warn(`could not index the registration of ${handle}:`, err));
}

/**
 * Per-IP throttle, shared by both write routes because both are unauthenticated
 * writes made on a stranger's behalf. The buckets are separate because they
 * spend different things — a registration spends relayer ETH and claims a handle
 * permanently, a profile edit rewrites one row — and because onboarding a shop
 * and then naming it is one continuous action that must not 429 halfway.
 */
interface Throttle {
  readonly cooldownMs: number;
  readonly errorName: string;
  readonly message: string;
  readonly last: Map<string, number>;
}

function throttle(cooldownMs: number, errorName: string, message: string): Throttle {
  return { cooldownMs, errorName, message, last: new Map() };
}

function assertNotThrottled(t: Throttle, key: string): void {
  const now = Date.now();
  const last = t.last.get(key);
  if (last !== undefined && now - last < t.cooldownMs) {
    throw new ApiError(429, t.errorName, t.message);
  }
  // Swept here rather than on a timer, because an entry older than the cooldown
  // is indistinguishable from an absent one — keeping it changes no decision.
  // These maps were unbounded and keyed by IP: fine while the route was reachable
  // only on a demo host, a slow leak once it is open to the internet, where the
  // key space is every address that ever tried. O(n) on a map whose live size is
  // bounded by callers-within-30s, on a path that already awaits a chain write.
  for (const [entry, at] of t.last) {
    if (now - at >= t.cooldownMs) t.last.delete(entry);
  }
}

/** Armed only AFTER the work succeeded, so a rejected attempt still surfaces its
 * real error on retry rather than a bogus 429 (faucet precedent). */
function armThrottle(t: Throttle, key: string): void {
  t.last.set(key, Date.now());
}

const registerThrottle = throttle(
  30_000,
  "OnboardingCooldown",
  "registration cooldown active; try again shortly",
);
const profileThrottle = throttle(
  10_000,
  "ProfileEditCooldown",
  "profile edit cooldown active; try again shortly",
);

/**
 * The bound that fits an AIMED attack, keyed by HANDLE rather than by caller.
 *
 * Every other limit in this file is per-IP or global, and neither touches the
 * shape defacement actually takes: one shop, rewritten repeatedly. A per-IP
 * cooldown is escaped by rotating IPs, and a global ceiling is escaped by
 * spending the whole budget on a single victim — the same attack with a receipt,
 * which is why the per-handle share above exists as well.
 *
 * The "25 requests from 25 forwarded IPs" figure recorded here previously was a
 * LOCALHOST artefact and is withdrawn: with `trust proxy = 1` a real proxy
 * appends the client address, so a forged `X-Forwarded-For` does not move
 * `req.ip` on a deployed host. It moves it here, where nothing sits in front.
 * The argument stands without the number — an attacker with genuinely distinct
 * addresses defeats a per-IP bound by definition — and a measurement that only
 * reproduces without the proxy should not be cited as if it were about
 * production.
 *
 * A minute is chosen against the CONTEST, not against the inconvenience: a
 * merchant fixing their own blurb waits once, an attacker in a rewrite loop is
 * reduced to sixty attempts an hour on one shop, and the real owner's correction
 * competes on the same footing instead of being drowned out.
 *
 * Deliberately NOT applied to an operator, and deliberately not shared with the
 * per-IP bucket: onboarding a shop and then naming it is one continuous action
 * that must not 429 halfway.
 */
const handleThrottle = throttle(
  60_000,
  "ProfileEditHandleCooldown",
  "this shop's profile was edited moments ago; try again shortly",
);

/**
 * The same global ceiling registration carries, for the same reason: the per-IP
 * cooldown bounds one browser and never one attacker. Higher than the
 * registration ceiling because an edit is reversible and legitimately repeated —
 * a merchant tuning their own blurb should not be competing for budget with a
 * room full of other merchants doing the same.
 */
const PROFILE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PUBLIC_PROFILE_EDITS_DAILY = 60n;
let profileBudget = emptyBudget();

/**
 * A per-HANDLE share of that budget, and without it the global one is a weapon.
 *
 * The 60s cooldown paces a defacement loop; it does not bound its TOTAL. Sixty
 * edits at one a minute is one hour to consume the entire deployment's 24-hour
 * allowance on a single victim — after which every profile edit on the rail
 * 429s for the remaining 23, INCLUDING the real owner's correction and every
 * other merchant's. That makes the claim this route is written around — "an edit
 * is reversible, the real merchant corrects it" — false under precisely the
 * attack the limits exist for. A control that converts a defacement into a
 * deployment-wide outage is worse than the thing it bounds.
 *
 * Ten leaves fifty for everyone else no matter what one shop attracts, and is
 * far above any honest use: a merchant fixing a typo does it once or twice.
 *
 * Swept on read, like the throttle maps and for the same reason — the key space
 * is every handle anyone has ever aimed at.
 */
const PER_HANDLE_EDITS_DAILY = 10n;
const handleBudgets = emptyHandleBudgets();

/**
 * Bounds CONCURRENT registrations per IP. The cooldown alone only rate-limits
 * strictly serial requests, because it is recorded after the tx confirms — so N
 * parallel requests all pass that check and enqueue N registrations against the
 * relayer, which holds the only gas key every door in the system depends on.
 */
const registerInFlight = new Set<string>();

/**
 * The ceiling the per-IP cooldown never was.
 *
 * A cooldown bounds one browser; it does not bound one attacker, who has as many
 * IPs as they care to use. That was tolerable while onboarding was demo-only and
 * stops being tolerable the moment it is open on a public host — and the thing
 * being bounded is NOT gas (this is Sepolia, and `registerMerchant` is ~180k).
 * It is that a registration is PERMANENT and its text renders on `/merchants`:
 * nothing can delete a handle, and `resolveProfile` refuses invisible and
 * deceptive text while having no opinion on offensive text. A global ceiling
 * makes the worst case a number we chose.
 *
 * `faucet-budget` rather than a second mechanism: it is the same shape, already
 * unit-tested, and it RESERVES before the spend, so concurrent requests cannot
 * both pass the check and overshoot — which a count-after-success scheme allows
 * by construction.
 *
 * NOT a security boundary, and the faucet's module says so in the same words:
 * the state is in-process, so a restart resets it and two instances would get
 * one ceiling each. This bounds casual abuse, which is the actual threat to a
 * testnet registry.
 */
const REGISTER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Registrations per rolling window, across every caller. Twenty is far above
 * any legitimate use of a demo — a room of judges trying the form is a handful —
 * and far below the number that would make the public directory unusable. */
export const PUBLIC_REGISTER_DAILY = 20n;
let registerBudget = emptyBudget();

/**
 * The same bound for profile edits, for the same reason.
 *
 * `armThrottle` runs only after the write confirms, so the cooldown alone
 * rate-limits strictly serial requests: N parallel PATCHes from one caller all
 * clear it and all enqueue a `setMerchantProfile` against the relayer. The
 * argument written above `registerInFlight` applies here word for word — this
 * route simply never inherited it.
 */
const profileInFlight = new Set<string>();

/**
 * Onboarding. `registerMerchant` is permissionless on-chain — anyone can call
 * it with their own gas — so relaying it here is faucet trust level: an
 * unauthenticated request that spends relayer ETH. Guarded the same way as the
 * faucet, with a per-IP cooldown and an in-flight guard.
 *
 * A taken handle is not pre-checked: sendRelayerTx simulates first, so the
 * duplicate reverts with HandleTaken before any gas is spent and the decoded
 * custom error reaches the client as a 409.
 */
export async function registerMerchant(
  req: RegisterMerchantRequest,
  ip: string | undefined,
  adminToken?: string,
): Promise<RegisterMerchantResponse> {
  /**
   * An operator, not a stranger at the form — same exemption `updateMerchantProfile`
   * already had, and it exists so `demo:reset` can seed the canonical shops
   * THROUGH this route instead of signing with the relayer key itself.
   *
   * That matters more than convenience. `relayer.ts` keeps the nonce in module
   * state and says so in as many words: an out-of-band send picks its nonce from
   * a lagging `pending` count, and the transaction that loses the resulting
   * replacement race is a settlement. demo-reset runs against a LIVE backend
   * minutes before a demo, so a second signer on that key is exactly the race the
   * queue exists to prevent — and the 30s per-IP cooldown that pushed the script
   * out of this route was a gap here, never a reason to go around it.
   */
  const operator = adminToken !== undefined && adminToken === config.adminToken;

  if (!operator && !config.onboardingEnabled) {
    throw new ApiError(
      403,
      "OnboardingDisabled",
      // NOT "merchants are verified": nothing anywhere in Gantry reviews or
      // verifies a merchant, and saying otherwise claims a KYC that does not
      // exist. This is now a switch an operator threw, not a policy — so it
      // says that, and says the rail is still open without us.
      "self-service onboarding is switched off on this deployment right now. " +
        "registerMerchant is permissionless on-chain, so you can register directly without us — " +
        "this route only offers to pay the gas for you.",
    );
  }
  if (!isValidHandle(req.handle)) {
    throw new ApiError(
      400,
      "InvalidHandle",
      "handle must be 1–32 characters of a–z, 0–9 or -, and cannot start or end with -",
    );
  }
  if (!isKnownCategory(req.categoryId)) {
    throw new ApiError(400, "InvalidCategory", `unknown category: ${req.categoryId}`, [
      req.categoryId,
    ]);
  }
  // EIP-55, not just hex shape: setMerchantPayout is gated on the payout address
  // itself, so a mistyped-but-well-formed address is unfixable by anyone.
  const payout = normalizePayout(req.payout);
  if (!payout.ok) {
    throw new ApiError(400, "InvalidPayout", payout.message, [payout.reason]);
  }
  // Before the tx, not after: the handle is claimed permanently, so a name we
  // would refuse to store must not cost a registration first.
  const profile = normalizeProfile(req);
  if (!profile.ok) {
    throw new ApiError(400, "InvalidProfile", profile.message, [profile.field]);
  }

  const key = ip ?? "unknown";
  if (!operator) assertNotThrottled(registerThrottle, key);
  if (registerInFlight.has(key)) {
    throw new ApiError(429, "OnboardingInProgress", "a registration from this address is already in flight");
  }
  // Cooldown → in-flight → ceiling, the order faucet-core uses: the two cheap
  // per-caller checks first, so a caller hammering one IP is turned away without
  // consuming a global budget everyone shares.
  // Everywhere, not just on a public host. The `!isDemoHost` clause this used
  // to carry was redundant against the case it was written for — `demo:reset`
  // seeds through this route with `x-admin-token`, so `operator` is already true
  // for it — and its only real effect was that the ceiling never ran on the
  // machine anyone tests on.
  const metered = !operator;
  if (metered) {
    const reservation = reserve(
      registerBudget,
      1n,
      PUBLIC_REGISTER_DAILY,
      Date.now(),
      REGISTER_WINDOW_MS,
    );
    registerBudget = reservation.state;
    if (!reservation.ok) {
      const resetInMs = msUntilReset(registerBudget, Date.now(), REGISTER_WINDOW_MS);
      throw new ApiError(
        429,
        "OnboardingBudgetExhausted",
        `this deployment registers at most ${PUBLIC_REGISTER_DAILY} shops a day and has used them ` +
          `all; the window rolls in about ${Math.ceil(resetInMs / 60_000)} minutes. ` +
          // The escape hatch is real and worth naming: the contract is
          // permissionless, so this ceiling bounds OUR relayer and not the rail.
          "registerMerchant is permissionless on-chain, so you can also register directly without us.",
      );
    }
  }

  registerInFlight.add(key);
  /**
   * Does this call keep its reservation?
   *
   * True when a shop was registered, and ALSO when the outcome is unknown — see
   * the `alreadyRegistered` branch, which cannot tell an earlier caller's handle
   * from this call's own late-mining transaction. Named for the accounting
   * question rather than for "did it create one", because those two answers
   * differ on exactly the branch that matters.
   *
   * A decodable revert creates nothing and releases: that one is a definite
   * non-occurrence, so a loop of them cannot exhaust a ceiling that exists to
   * bound how many merchants appear.
   */
  let charged = false;
  try {
    const { receipt } = await sendRelayerTx({
      address: config.addresses.gantryCore,
      abi: gantryCoreAbi,
      functionName: "registerMerchant",
      // The profile rides in the registration now, so a shop can never be live and
      // unnamed: there is no second write to fail after the handle is claimed.
      args: [
        req.handle,
        payout.address,
        req.categoryId,
        profile.value.displayName,
        profile.value.location,
        profile.value.blurb,
      ],
    });
    // Cooldown only after a successful register, so a reverted attempt still
    // surfaces its real error on retry rather than a bogus 429 (faucet precedent).
    if (!operator) armThrottle(registerThrottle, key);
    charged = true;
    primeRegistration(req.handle, req.categoryId, profile.value, receipt.blockNumber);
    console.log(
      `registered ${req.handle} → ${payout.address} (category ${req.categoryId}) in ${receipt.transactionHash}`,
    );
    return {
      ...primeCache(req.handle, payout.address, req.categoryId, profile.value),
      txHash: receipt.transactionHash,
      alreadyRegistered: false,
    };
  } catch (err) {
    // Never assume "the relayer helper threw ⇒ the tx did not happen" — the
    // receipt wait caps at 20s, and a register that mines just past it would
    // otherwise come back to its own owner as "that handle is taken, pick
    // another". Prove the outcome on-chain first, as bridge.ts and pbm.ts do.
    const landed = await ownsHandle(req.handle, payout.address);
    if (landed) {
      console.warn(
        `register for ${req.handle} reported a failure but the handle is on-chain ` +
          `pointing at ${payout.address} — treating as already registered`,
      );
      if (!operator) armThrottle(registerThrottle, key);
      // CHARGED, because this branch cannot tell whose write it was.
      //
      // `ownsHandle` matches on THIS request's own payout address, so it fires
      // both for a handle an earlier call claimed AND for this call's own
      // transaction mining just past the relayer's 20s receipt cap — which is
      // the case the surrounding catch exists to detect. Releasing the
      // reservation on the second one hands back budget for a permanent,
      // undeletable registration, so the ceiling that bounds how many merchants
      // appear is bypassed by whatever makes receipts slow.
      //
      // Ambiguity is charged, matching the same fail-closed rule `ownsHandle`
      // and `isFactoryWallet` already follow. The cost of being wrong is one
      // registration of headroom; the cost the other way is an unbounded one.
      charged = true;
      // Primed from what the CHAIN holds, never from this request. On this branch
      // THIS transaction reverted (HandleTaken) — the one that landed was an
      // earlier attempt, and it carried whatever text that attempt sent. Echoing
      // the current request's name back would be a claim about the chain that is
      // wrong, cached for a minute, and indistinguishable from a successful edit.
      return {
        ...primeCacheFrom(req.handle, landed),
        txHash: null,
        alreadyRegistered: true,
      };
    }
    console.error(`register failed for ${req.handle} (payout ${payout.address}):`, err);
    throw err;
  } finally {
    registerInFlight.delete(key);
    if (metered && !charged) registerBudget = release(registerBudget, 1n);
  }
}

/**
 * Written only AFTER the chain write, and never allowed to fail the request.
 * registerMerchant is the irreversible half — a merchant whose tx mined owns
 * that handle forever — so reporting "registration failed" because a local cache
 * write threw would send them to re-register a handle they already hold, which
 * is the exact outcome ownsHandle exists to prevent. The profile is the
 * recoverable half: PATCH rewrites it.
 */
/**
 * A ceiling on what one unauthenticated request can make the relayer pay for.
 *
 * `normalizeProfile` caps CODEPOINTS (60/80/140), and four-byte emoji turn that
 * into 1,120 bytes — roughly fifteen times an empty write, and this route is
 * unauthenticated on a demo host and replayable on the same handle forever, each
 * rewrite re-paying cold SSTOREs. Registering at least claims a permanent handle
 * per spend; this buys nothing. Draining the gas key stops EVERY door, so the
 * bound is on the thing that actually costs: total bytes.
 *
 * 600 is far above real text — the canonical demo shop is ~180 — and far below
 * the pathological maximum. It is a spend limit, not a content rule, which is
 * why it lives here and not in `normalizeProfile`.
 */
const PROFILE_BYTE_BUDGET = 600;

function assertAffordable(profile: MerchantProfile): void {
  const bytes = new TextEncoder().encode(
    profile.displayName + profile.location + profile.blurb,
  ).length;
  if (bytes > PROFILE_BYTE_BUDGET) {
    throw new ApiError(
      413,
      "ProfileTooHeavy",
      `this profile is ${bytes} bytes and the limit for a single write is ${PROFILE_BYTE_BUDGET}. ` +
        "Each character costs gas we pay on your behalf; emoji cost four bytes each.",
    );
  }
}

/**
 * PATCH /api/merchants/:handle — the display record, now an ON-CHAIN write.
 *
 * `setMerchantProfile` is `onlyRelayer`, so this route is the only way the text
 * can change and the relayer key is the only thing that can do it. That is a
 * deliberate position rather than an accident: Gantry has no merchant login and
 * the back-office has no wallet, so a merchant-signed write would need both,
 * and a permissionless one would let anyone rename any shop. The record is
 * therefore OPERATOR-owned, the UI says so, and the honest-labels list carries
 * it. The contract cannot touch payout, handle or category through this path.
 *
 * OPEN on every host since 21 Aug, alongside registration, and bounded the same
 * way — but with one control registration does not have, because the two abuse
 * shapes differ. Registration is spread thin (many handles, each claimed once)
 * and its risk is PERMANENCE. An edit is aimed (one shop, over and over) and its
 * risk is a re-deface loop, which a global count does nothing about: an attacker
 * simply spends the whole daily budget on one victim. So edits carry a per-HANDLE
 * cooldown as well, which bounds the loop where it actually happens and leaves
 * every other merchant unaffected.
 *
 * What is NOT at risk here, and it is why this can be open at all: the contract
 * cannot touch payout, handle or category through this path, so an edit moves no
 * money and redirects no payment — the payer arrived at a handle they scanned off
 * the shop's own code, and the payout behind it is unreachable from here. And
 * unlike a registration an edit is REVERSIBLE: the real merchant edits it back
 * through the same open route. Defacement, not theft, and self-healing.
 *
 * The real fix remains authentication rather than rate limiting, and it exists
 * already one function away: `setMerchantPayout` is gated on
 * `msg.sender == merchant.payout`, so a merchant CAN prove ownership. Verify a
 * signature from the payout address here and every limit below becomes belt and
 * braces. `PROFILE_EDITS=closed` is the switch until then.
 */
export async function updateMerchantProfile(
  handle: string,
  req: UpdateMerchantProfileRequest,
  ip: string | undefined,
  adminToken: string | undefined,
): Promise<MerchantResponse> {
  const operator = adminToken !== undefined && adminToken === config.adminToken;

  if (!operator && !config.profileEditsEnabled) {
    throw new ApiError(
      403,
      "ProfileEditingDisabled",
      "profile editing is switched off on this deployment right now. Nothing about a shop's " +
        "money is affected either way — this route cannot touch a payout, a handle or a category.",
    );
  }
  if (!isValidHandle(handle)) {
    throw new ApiError(400, "InvalidHandle", `not a valid merchant handle: ${handle}`);
  }
  const profile = normalizeProfile(req);
  if (!profile.ok) {
    throw new ApiError(400, "InvalidProfile", profile.message, [profile.field]);
  }
  assertAffordable(profile.value);

  const key = ip ?? "unknown";
  if (!operator) {
    assertNotThrottled(profileThrottle, key);
    // Per-handle AFTER per-IP: a caller already inside their own cooldown learns
    // that first, rather than being told about a shop they were not going to be
    // allowed to edit anyway.
    assertNotThrottled(handleThrottle, handle);
  }
  if (profileInFlight.has(key)) {
    throw new ApiError(429, "ProfileEditInProgress", "a profile edit from this address is already in flight");
  }
  // See the note on the register path: metered everywhere, because the operator
  // exemption already covers the rehearsal case and an unexercised limit is an
  // untested one.
  const metered = !operator;
  if (metered) {
    const now = Date.now();
    // PER-HANDLE FIRST, and the order is the whole point: a shop that has used
    // its own share must be refused WITHOUT touching the shared budget, or the
    // per-handle cap achieves nothing — the attacker's refused attempts would
    // still be the thing that drains everyone else's allowance.
    const perHandle = reserveForHandle(
      handleBudgets,
      handle,
      PER_HANDLE_EDITS_DAILY,
      now,
      PROFILE_WINDOW_MS,
    );
    if (!perHandle.ok) {
      const resetInMs = perHandle.resetInMs;
      throw new ApiError(
        429,
        "ProfileEditHandleBudgetExhausted",
        `this shop's profile has been changed ${PER_HANDLE_EDITS_DAILY} times today, which is as ` +
          `many as this deployment relays for one shop; the window rolls in about ` +
          `${Math.ceil(resetInMs / 60_000)} minutes. Nothing about its money is affected.`,
      );
    }
    const reservation = reserve(profileBudget, 1n, PUBLIC_PROFILE_EDITS_DAILY, now, PROFILE_WINDOW_MS);
    profileBudget = reservation.state;
    if (!reservation.ok) {
      releaseForHandle(handleBudgets, handle);
      const resetInMs = msUntilReset(profileBudget, now, PROFILE_WINDOW_MS);
      throw new ApiError(
        429,
        "ProfileEditBudgetExhausted",
        `this deployment relays at most ${PUBLIC_PROFILE_EDITS_DAILY} profile edits a day and has ` +
          `used them all; the window rolls in about ${Math.ceil(resetInMs / 60_000)} minutes.`,
      );
    }
  }

  profileInFlight.add(key);
  /** Only a write that actually landed keeps its reservation — same rule as the
   * register path. A 404 for an unregistered handle changes nothing on-chain and
   * must not spend from a budget that bounds how often the rail is rewritten. */
  let written = false;
  // Wraps the read as well as the write: `getMerchant` throws a 404 for an
  // unregistered handle, and releasing only in the write's own `finally` would
  // leak the key on that path and wedge the caller out of every later edit.
  try {
    // 404s for a handle nobody registered, before any gas is spent. The contract
    // rejects it too (MerchantNotFound), but paying for that revert to learn what a
    // read already knows is the wrong order.
    const merchant = await getMerchant(handle);

    // Unlike the register path this write IS the request, so a failure must fail
    // it — there is nothing else that happened to report.
    try {
      await sendRelayerTx({
        address: config.addresses.gantryCore,
        abi: gantryCoreAbi,
        functionName: "setMerchantProfile",
        args: [merchant.merchantId, profile.value.displayName, profile.value.location, profile.value.blurb],
      });
    } catch (err) {
    // `sendRelayerTx` SIMULATES before it broadcasts, so a decodable revert is a
    // definite "this did not happen" — rethrow it and let the middleware map the
    // contract's own error name. Everything else (a 20s receipt cap, a dropped
    // connection, a throttled node during the poll) is UNKNOWN, and the chain is
    // the only thing that can settle it. Same rule registerMerchant applies with
    // `ownsHandle`; this path simply never had it.
      if (decodeGantryError(err).kind !== "unknown") throw err;
      const landed = await readMerchantFresh(merchant.merchantId).catch((probeErr: unknown) => {
        // LOGGED, not swallowed. This read is the only thing that separates
        // "definitely did not happen" from "may still land", and since the limits
        // below turn on that verdict it now also decides whether an abuse budget
        // is charged. A silent null makes a failing READ indistinguishable from a
        // failing WRITE — different providers, different fixes — which is the one
        // bare swallow the sibling probe (`ownsHandle`) was fixed to stop doing.
        console.error(`profile confirmation read for ${handle} failed:`, probeErr);
        return null;
      });
      if (landed && sameProfile(landed, profile.value)) {
        console.warn(`profile write for ${handle} reported a failure but the chain already holds it`);
      } else {
        // UNKNOWN, so charge it. Everything below this line — both cooldowns and
        // the reservation — used to sit on the success path only, so a write that
        // mined one second past the relayer's 20s receipt cap defaced a shop and
        // cost the caller NOTHING: no per-handle cooldown, no per-IP cooldown, and
        // a refunded reservation. The daily ceiling never moved, and the docblock
        // above promising "sixty attempts an hour on one shop" was false on the
        // one branch an attacker can reach on demand by making receipts slow.
        //
        // The same compensation invariant the money paths follow, applied to
        // accounting rather than to refunds: `landed === null` here means the
        // chain did not settle it either way, and ambiguity is charged, not
        // forgiven. A DISPROVED write (`landed` present and different) falls to
        // the release below, because that one is a definite non-occurrence.
        if (!operator) {
          armThrottle(profileThrottle, key);
          armThrottle(handleThrottle, handle);
        }
        written = true;
        // 502 with a name the CLIENT can branch on. It used to fall through to
        // `InternalError`, which is exactly the name the screen's "may still have
        // been saved" hedge does not match — so the likeliest unknown outcome was
        // the one case presented as a definite failure.
        throw new ApiError(
          502,
          "ProfileWriteUnresolved",
          "the profile transaction was broadcast and could not be confirmed in time. It may still " +
            "land. Reload this screen to see what is stored before saving again.",
        );
      }
    } finally {
      // UNCONDITIONAL, and that is the point. `getMerchant` above just populated
      // this entry with the PRE-write text, and the relayer caps its receipt wait
      // at 20s — so a write that timed out and then mined would leave the screen
      // being told "failed" while every read for the next minute served the old
      // name from cache and appeared to confirm it. Two independent-looking
      // signals agreeing on something false is worse than either alone.
      cache.delete(handle);
    }
    if (!operator) {
      armThrottle(profileThrottle, key);
      // Armed on the HANDLE too, and only now: a rejected attempt must not lock
      // a shop's own owner out of correcting it.
      armThrottle(handleThrottle, handle);
    }
    written = true;
    console.log(`profile updated for ${handle}: ${profile.value.displayName}`);
    return { ...merchant, ...profile.value };
  } finally {
    profileInFlight.delete(key);
    // Both reservations, or the per-handle share ratchets down on failed edits
    // and a shop becomes uneditable by its own owner.
    if (metered && !written) {
      profileBudget = release(profileBudget, 1n);
      releaseForHandle(handleBudgets, handle);
    }
  }
}

/**
 * Did this registration actually land, whatever the relayer reported? Reads the
 * registry directly — the only honest answer. Fails closed: a failed probe
 * reports the original error rather than claiming a registration succeeded.
 */
async function ownsHandle(handle: string, payout: Address): Promise<ChainMerchant | null> {
  try {
    const landed = await readMerchantFresh(merchantId(handle));
    if (!landed) return null;
    return landed.payout.toLowerCase() === payout.toLowerCase() ? landed : null;
  } catch (probeErr) {
    console.error(`ownership probe for ${handle} failed:`, probeErr);
    return null;
  }
}

/** Prime the 60s cache so the immediate redirect to /pay/<handle> doesn't race a
 * fresh chain read. Nothing to invalidate: only successful lookups are cached
 * and this handle had none (the 404 path throws before cache.set). */
function primeCache(
  handle: string,
  payout: Address,
  categoryId: number,
  profile: MerchantProfile,
): MerchantResponse {
  return primeCacheFrom(handle, { payout, categoryId, ...profile });
}

/** Prime from a record we READ rather than one we sent. The two differ exactly
 * when a write did not land the way the caller thinks it did, which is the case
 * worth being careful about. */
function primeCacheFrom(handle: string, value: ChainMerchant): MerchantResponse {
  cache.set(handle, { at: Date.now(), value });
  // Usually absent on the register path: `primeRegistration` still has a block
  // read in flight, and the sweep is up to 15s away. The field is omitted rather
  // than guessed, and the shop's own screens pick it up on their next load.
  return compose(handle, merchantId(handle), value, registeredAtOf(handle));
}
