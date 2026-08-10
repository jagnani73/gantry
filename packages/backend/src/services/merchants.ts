import { keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import {
  LOG_CHUNK_SPAN,
  categoryName,
  gantryCoreAbi,
  isKnownCategory,
  isValidHandle,
  normalizePayout,
  type MerchantResponse,
  type RegisterMerchantRequest,
  type RegisterMerchantResponse,
  type UpdateMerchantProfileRequest,
  decodeGantryError,
} from "@gantry/shared";
import { publicClient } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";
import { normalizeProfile, resolveProfile, type MerchantProfile } from "./merchants-core";

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

export interface MerchantLookupOptions {
  /**
   * Wait briefly for the registration date rather than serving whatever is
   * already resolved. Display surfaces want it; the PAYMENT path must not have
   * it — getMerchant runs on every intent and every 402 challenge, and a payment
   * queueing behind a log query is a worse failure than a missing date.
   */
  waitForRegisteredAt?: boolean;
}

export async function getMerchant(
  handle: string,
  opts: MerchantLookupOptions = {},
): Promise<MerchantResponse> {
  if (!isValidHandle(handle)) {
    throw new ApiError(400, "InvalidHandle", `not a valid merchant handle: ${handle}`);
  }
  const id = merchantId(handle);
  const chain = await readMerchant(handle, id);
  const at = await registeredAtOf(handle, opts.waitForRegisteredAt === true);
  return compose(handle, id, chain, at);
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
 * Registration timestamps, resolved once and then kept forever — the block a
 * merchant registered in cannot change. Permanence is the whole point: without
 * it every merchant lookup would carry a log query.
 *
 * Keyed by the handle EXACTLY as the log carried it. Lowercasing would let a
 * mixed-case handle registered straight on-chain answer for a different
 * merchantId, and these two are different merchants.
 */
const registrationTimes = new Map<string, number>();

/**
 * There is no cheap "when did this one handle register" query. A full-range
 * getLogs filtered on the indexed merchantId would be one call, but no provider
 * in the fallback chain will serve it: measured 8 Aug 2026, Alchemy's free tier
 * caps eth_getLogs at a TEN block range and sepolia.base.org at 2000. So the
 * range has to be walked, and the walk is amortised — one pass records EVERY
 * MerchantRegistered it sees, not just the handle that triggered it.
 *
 * Three things keep that affordable:
 *  - only display requests start a pass (see `waitForRegisteredAt`); the payment
 *    path never triggers RPC work it does not need;
 *  - a pass is capped and RESUMABLE, so it never monopolises the transport a
 *    live payment is settling on, and picks up where it stopped;
 *  - a merchant registered THROUGH this backend never needs it at all — the
 *    receipt already names the block (`primeRegisteredAt`).
 */
const SCAN_CHUNK = LOG_CHUNK_SPAN;
const SCAN_CHUNKS_PER_PASS = 24;
const SCAN_COOLDOWN_MS = 30_000;
/** How long a display request waits on a pass in progress. */
const REGISTERED_AT_WAIT_MS = 1_500;
const POLL_MS = 100;

/** Last block scanned; null = never started. Survives a failed pass, so the
 * next one resumes rather than re-walking from the deploy block. */
let scanCursor: bigint | null = null;
let scanning: Promise<void> | null = null;
let scanNextAt = 0;

async function registeredAtOf(handle: string, wait: boolean): Promise<number | undefined> {
  const known = registrationTimes.get(handle);
  if (known !== undefined) return known;
  if (!wait) return undefined;

  const pass = startScan();
  if (!pass) return undefined; // cooling down; the field is simply absent

  // Polled rather than wired to a per-handle waiter: a pass fills the map chunk
  // by chunk, so the answer usually lands in the first chunk or two and this
  // request has no reason to wait for the rest of the range.
  let done = false;
  void pass.then(() => {
    done = true;
  });
  const deadline = Date.now() + REGISTERED_AT_WAIT_MS;
  while (!done && Date.now() < deadline) {
    await expire(POLL_MS);
    const at = registrationTimes.get(handle);
    if (at !== undefined) return at;
  }
  return registrationTimes.get(handle);
}

function expire(ms: number): Promise<undefined> {
  return new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), ms).unref();
  });
}

/** The pass in flight, starting one if the cooldown has elapsed; null when the
 * caller should just go without a date this time. */
function startScan(): Promise<void> | null {
  if (scanning) return scanning;
  if (Date.now() < scanNextAt) return null;
  scanning = scanRegistrations().finally(() => {
    scanning = null;
    scanNextAt = Date.now() + SCAN_COOLDOWN_MS;
  });
  return scanning;
}

/**
 * Resolves rather than rejects, always: callers race it against a timer, and an
 * unhandled rejection would take the process down over a display field.
 */
async function scanRegistrations(): Promise<void> {
  try {
    const head = await publicClient.getBlockNumber();
    let from = (scanCursor ?? config.deployBlock - 1n) + 1n;
    for (let chunk = 0; chunk < SCAN_CHUNKS_PER_PASS && from <= head; chunk++) {
      const to = from + SCAN_CHUNK > head ? head : from + SCAN_CHUNK;
      const logs = await publicClient.getContractEvents({
        address: config.addresses.gantryCore,
        abi: gantryCoreAbi,
        eventName: "MerchantRegistered",
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const handle = log.args.handle;
        if (handle && log.blockNumber !== null && !registrationTimes.has(handle)) {
          await rememberBlockTime(handle, log.blockNumber);
        }
      }
      scanCursor = to;
      from = to + 1n;
    }
  } catch (err) {
    // The cursor keeps whatever the pass managed, so the next one resumes.
    console.warn(
      "registration-date scan pass failed (registeredAt stays absent until it resumes):",
      err instanceof Error ? err.message : err,
    );
  }
}

async function rememberBlockTime(handle: string, blockNumber: bigint): Promise<number> {
  const block = await publicClient.getBlock({ blockNumber });
  const at = Number(block.timestamp);
  registrationTimes.set(handle, at);
  return at;
}

/**
 * The block a fresh registration mined in IS the registration date, so reading
 * it here saves the log query entirely for a shop that just onboarded. Never
 * awaited: the merchant's response must not wait on it, and a failure only
 * leaves the normal lookup to run later.
 */
function primeRegisteredAt(handle: string, blockNumber: bigint): void {
  void rememberBlockTime(handle, blockNumber).catch((err) =>
    console.warn(`could not read the registration block time for ${handle}:`, err),
  );
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
  const last = t.last.get(key);
  if (last !== undefined && Date.now() - last < t.cooldownMs) {
    throw new ApiError(429, t.errorName, t.message);
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
 * Bounds CONCURRENT registrations per IP. The cooldown alone only rate-limits
 * strictly serial requests, because it is recorded after the tx confirms — so N
 * parallel requests all pass that check and enqueue N registrations against the
 * relayer, which holds the only gas key every door in the system depends on.
 */
const registerInFlight = new Set<string>();

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
      // exist. What this gate protects is the relayer's gas key, which is the
      // honest reason and the only one.
      "self-service onboarding is off on this deployment: registering through this route spends " +
        "Gantry's own gas key. Run the backend without NODE_ENV=production to onboard (demo host), " +
        "or register on-chain directly. registerMerchant is permissionless and needs no permission from us.",
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

  registerInFlight.add(key);
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
    primeRegisteredAt(req.handle, receipt.blockNumber);
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
 * Still gated: it spends the relayer's gas, so the same host-class rule and
 * per-IP cooldown as self-service onboarding apply, and a valid admin token
 * means an operator is calling (demo-reset) and is exempt from both.
 */
export async function updateMerchantProfile(
  handle: string,
  req: UpdateMerchantProfileRequest,
  ip: string | undefined,
  adminToken: string | undefined,
): Promise<MerchantResponse> {
  const operator = adminToken !== undefined && adminToken === config.adminToken;

  if (!operator && config.hostClass !== "demo") {
    throw new ApiError(
      403,
      "ProfileEditingDisabled",
      "profile editing is off on this deployment: the route is unauthenticated, so anyone with " +
        "the URL could rewrite any shop's identity. Edit on the demo host, or call with x-admin-token.",
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
  if (!operator) assertNotThrottled(profileThrottle, key);

  // 404s for a handle nobody registered, before any gas is spent. The contract
  // rejects it too (MerchantNotFound), but paying for that revert to learn what a
  // read already knows is the wrong order.
  //
  // WITHOUT `waitForRegisteredAt`: that flag can start a 24-window log walk and
  // block up to 1.5s, on the same transport this is about to send a transaction
  // through — and the registration date is not in this response's critical path.
  // The display surfaces that actually want it ask for it themselves.
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
    const landed = await readMerchantFresh(merchant.merchantId).catch(() => null);
    if (landed && sameProfile(landed, profile.value)) {
      console.warn(`profile write for ${handle} reported a failure but the chain already holds it`);
    } else {
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
  if (!operator) armThrottle(profileThrottle, key);
  console.log(`profile updated for ${handle}: ${profile.value.displayName}`);
  return { ...merchant, ...profile.value };
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
 * and this handle had none (the 404 path throws before cache.set). The profile
 * is read back out of SQLite rather than passed in, so the response says what
 * was actually stored. */
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
  return compose(handle, merchantId(handle), value, registrationTimes.get(handle));
}
