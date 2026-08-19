import { privateKeyToAccount } from "viem/accounts";
import {
  BASESCAN_BASE_URL,
  DEMO_MERCHANTS,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  BASE_SEPOLIA_ADDRESSES,
  agentStatus,
  selectAgentWallet,
  parseSgd,
  reviveSpendAuthorization,
  type AgentListResponse,
  type AgentSummary,
  type MerchantResponse,
  type PbmIntentResponse,
  tokenAddress as gantryTokenAddress,
  type X402PaymentRequirements,
} from "@gantry/shared";
import { env, payToken, requireSigningEnv } from "./env";

/**
 * The deterministic gantry-pbm client — bare fetch + the owned wire codec,
 * deliberately NOT @x402/fetch (whose client scheme registry is exact-only;
 * scripts/x402-buy.ts stays the untouched vanilla interop proof). Every
 * function here is LLM-free: the model narrates and decides, this module
 * moves the money. Reused verbatim by the scripted fallback and the e2e
 * script, so all three paths exercise the same wire behavior.
 *
 * payMerchant NEVER throws — every failure (transport included) comes back as
 * a structured PayResult. That contract is load-bearing: a thrown tool run
 * reaches the LLM as a bare is_error result it might reasonably retry, and a
 * retry after the paid request was sent could pay twice.
 */

export type PayResult =
  | {
      success: true;
      handle: string;
      sgd: string;
      /** Token units actually paid (the ceil quote), 6dp decimal string. */
      amountToken: string;
      txHash?: string;
      explorerUrl?: string;
      /** On-chain payer — the PBM wallet, not the agent's key (non-custodial). */
      payer?: string;
      /** Set when settlement is confirmed but the tx hash is not yet known. */
      note?: string;
    }
  | {
      success: false;
      handle: string;
      sgd: string;
      errorReason: string;
      errorMessage: string;
    };

export type MerchantListEntry = MerchantResponse | { handle: string; error: string };

/** Lookup failures stay IN the result (with an `error` field) — silently
 * dropping a merchant would let the model conclude it doesn't exist and skip
 * the rejection beat entirely. */
export async function listMerchants(): Promise<MerchantListEntry[]> {
  const merchants: MerchantListEntry[] = [];
  for (const handle of Object.keys(DEMO_MERCHANTS)) {
    try {
      const res = await fetch(`${env.gantryApi}/api/merchants/${handle}`);
      if (res.ok) {
        merchants.push((await res.json()) as MerchantResponse);
      } else {
        console.error(`listMerchants: ${handle} lookup failed (${res.status})`);
        merchants.push({ handle, error: `lookup failed (status ${res.status})` });
      }
    } catch (err) {
      console.error(`listMerchants: ${handle} lookup threw`, err);
      merchants.push({ handle, error: "lookup failed (network error)" });
    }
  }
  return merchants;
}

export type PolicyResult = AgentSummary | { error: string };

/**
 * Which PBM wallet this agent acts for, discovered rather than configured.
 *
 * Cached for the process: a wallet's `agentSigner` can be rotated, but not
 * mid-run, and re-walking `WalletCreated` logs on every tool call would put a
 * multi-second event scan in front of a payment. Only the ADDRESS is cached —
 * policy state is re-read every time, since `spentToday` moves with each spend.
 */
let cachedWallet: `0x${string}` | null = null;

async function resolveAgentWallet(signer: `0x${string}`): Promise<`0x${string}`> {
  if (cachedWallet) return cachedWallet;
  const res = await fetch(`${env.gantryApi}/api/agents?agentSigner=${signer}`);
  if (!res.ok) throw new Error(`agent wallet lookup failed (status ${res.status})`);
  const { agents } = (await res.json()) as AgentListResponse;
  // Prefer a wallet that can actually spend. A lapsed or revoked one would fail
  // every payment with PolicyExpired, and picking it because it happened to be
  // first would read on stage as "the agent is broken" rather than "that policy
  // is over".
  //
  // Among those, take the NEWEST, not the first. One signer can be listed by
  // several wallets and always will be here: the factory is permissionless,
  // nothing can ever delete a wallet, and this demo migrated from a
  // relayer-owned wallet to a payer-owned one — so both list this key forever.
  // The API returns them in WalletCreated log order, and the most recently
  // created is the one whose owner set it up last and the one demo-reset funds
  // and arms. Taking the first instead pins the agent to the oldest wallet it
  // has ever had, which is precisely the one nobody maintains: it would spend
  // from an unfunded wallet whose spentToday never resets, while the payer app
  // showed a healthy meter on a different wallet that never moves.
  // A PIN beats every heuristic below, and only a pin is actually safe.
  // `createWallet` is permissionless and takes `agentSigner` unproven, so anyone
  // can mint a wallet naming this key — and since selection prefers the newest,
  // an attacker can always mint a newer one and move which wallet this agent
  // acts through. The EIP-712 domain binds each signature to its own wallet, so
  // nothing is stolen, but the policy that is supposed to constrain this agent
  // quietly becomes a stranger's policy instead of its owner's, and no wallet
  // can ever be deleted to undo it.
  if (env.agentWallet) {
    const pinned = agents.find((a) => a.wallet.toLowerCase() === env.agentWallet!.toLowerCase());
    if (!pinned) {
      throw new Error(
        `AGENT_WALLET is ${env.agentWallet} but that wallet does not list ${signer} as its agent ` +
          `signer. Rotate the key on that wallet, or clear AGENT_WALLET to discover one.`,
      );
    }
    cachedWallet = pinned.wallet;
    return cachedWallet;
  }

  const now = Math.floor(Date.now() / 1000);
  // CURRENCY FIRST, then newest-active — and the rule lives in shared because
  // THREE places apply it (here, demo-reset's provisioning, and demo-reset's
  // step 6b check) and they have drifted before: the script armed one wallet
  // while this resolved another. `token` is what the wallet actually holds,
  // read live, so this asks "which of these can pay in my currency".
  const usable = selectAgentWallet(agents, payToken(), (a) => agentStatus(a, now) === "active");
  if (!usable) {
    throw new Error(`no PBM wallet lists ${signer} as its agent signer. Has one been created?`);
  }
  // Say which one, and say it out loud when the choice was not forced. This is
  // the failure that looks healthy from both ends, so it must be visible on the
  // terminal that is about to spend money. console.error is outside the LLM's
  // input path, so it cannot be paraphrased away.
  //
  // The two branches are NOT cosmetic. On the `agents.at(-1)` fallback nothing
  // is active, so calling it "the newest active one" would print the one thing
  // an operator must not believe at that moment: every spend from that wallet is
  // about to revert PolicyExpired, and the fix is to arm it, not to debug the
  // payment.
  if (agents.length > 1) {
    // Asked of the CHOSEN wallet rather than recomputed over the pool: the two
    // are the same question, and the pool no longer exists here now that the
    // selection rule lives in shared.
    console.error(
      agentStatus(usable, now) === "active"
        ? `agent: ${agents.length} wallets list this signer; spending from the newest ACTIVE one, ${usable.wallet}`
        : `agent: ${agents.length} wallets list this signer and NONE has a live policy; ` +
            `falling back to the newest, ${usable.wallet}. Expect PolicyExpired until it is re-armed.`,
    );
    // More than one wallet naming this signer is expected here — the factory is
    // permissionless and this demo migrated between wallets — but it is also
    // exactly what a hijack looks like, and the two are indistinguishable from
    // this side. Name the remedy rather than leaving the operator to weigh it.
    console.error(
      `agent: any of those could have been created by anyone — createWallet takes agentSigner ` +
        `unproven. Set AGENT_WALLET to pin the one you own if this is not a machine you control.`,
    );
  }
  cachedWallet = usable.wallet;
  return cachedWallet;
}

/** Like listMerchants, a failure stays IN the result: a thrown read tool is
 * swallowed by the AI SDK and fed back to the model as narration input, which
 * it may paraphrase away. A structured `error` field it is told to report is
 * strictly better than an exception it never sees. */
export async function checkPolicy(): Promise<PolicyResult> {
  try {
    const { signer } = requireSigningEnv();
    const wallet = await resolveAgentWallet(signer);
    const res = await fetch(`${env.gantryApi}/api/agents/${wallet}`);
    if (!res.ok) {
      console.error(`checkPolicy: GET /api/agents/${wallet} failed (${res.status})`);
      return { error: `policy lookup failed (status ${res.status})` };
    }
    return (await res.json()) as AgentSummary;
  } catch (err) {
    console.error("checkPolicy: agent lookup threw", err);
    return { error: err instanceof Error ? err.message : "policy lookup failed (network error)" };
  }
}

export async function payMerchant(handle: string, sgd: string): Promise<PayResult> {
  const fail = (errorReason: string, errorMessage: string): PayResult => ({
    success: false,
    handle,
    sgd,
    errorReason,
    errorMessage,
  });

  // Inside the never-throws contract, not above it: both of these can throw on
  // a malformed env or an LLM-supplied amount like "S$19.50", and a thrown tool
  // reaches the model as a bare error result it might reasonably retry.
  let key: `0x${string}`;
  let signer: `0x${string}`;
  try {
    ({ key, signer } = requireSigningEnv());
    parseSgd(sgd); // fail fast on garbage before any HTTP
  } catch (err) {
    return fail("invalid_request", err instanceof Error ? err.message : String(err));
  }

  // Resolving the wallet is a network call, so it sits inside the never-throws
  // contract too. It happens BEFORE any intent is created: discovering here that
  // no wallet exists is a clean "nothing to pay from", where discovering it
  // after would strand an intent nobody can settle.
  let wallet: `0x${string}`;
  try {
    wallet = await resolveAgentWallet(signer);
  } catch (err) {
    return fail("no_agent_wallet", err instanceof Error ? err.message : String(err));
  }

  // The agent-only endpoint by default; the DUAL-DOOR pay link when asked.
  //
  // Both routes share one `orderAccepts` array by reference, so this changes the
  // string and the verb and nothing else about the payment. It exists so the
  // demo's strongest line can be literally true: the agent is handed the same
  // URL the tourist just opened, and anyone in the room can check that claim
  // afterwards by opening it themselves.
  const payLink = `${env.gantryApi}/pay/${handle}?sgd=${encodeURIComponent(sgd)}`;
  const orderUrl = env.usePayLink
    ? payLink
    : `${env.gantryApi}/api/order/${handle}?sgd=${encodeURIComponent(sgd)}`;
  // GET on the pay link because a person opens it in a browser; the agent-only
  // route stays a POST. Everything after this line is identical either way.
  const orderMethod = env.usePayLink ? "GET" : "POST";

  // ------------------------------------------------------------------ pre-payment
  // Steps 1-5: nothing irreversible happens here (an abandoned intent just
  // expires), so a transport failure is safe to retry once.
  let offer: X402PaymentRequirements;
  let intent: PbmIntentResponse;
  let signature: `0x${string}`;
  let resource: { url: string } | undefined;
  try {
    // 1. The 402 challenge.
    const challenge = await fetch(orderUrl, { method: orderMethod });
    if (challenge.status !== 402) {
      return fail("unexpected_status", `expected a 402 challenge, got ${challenge.status}`);
    }
    const requiredHeader = challenge.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!requiredHeader) return fail("missing_header", "402 carried no PAYMENT-REQUIRED header");
    let required;
    try {
      required = decodePaymentRequiredHeader(requiredHeader);
    } catch {
      return fail("malformed_header", "PAYMENT-REQUIRED header did not decode (proxy mangling?)");
    }
    resource = required.resource;

    // 2. Select the pbm offer — never fall back to exact (the non-custodial
    //    path IS the story; a missing offer is a server misconfiguration).
    //    The server offers one gantry-pbm entry per payable token, so pick the
    //    one in THIS agent's currency rather than whichever came first. Taking
    //    the first entry blindly is what made a euro agent create a euro intent
    //    against a dollar offer and get told `quote_changed` — technically
    //    correct and useless as an explanation.
    const pbmOffers = required.accepts.filter(
      (a): a is X402PaymentRequirements => a.scheme === "gantry-pbm",
    );
    if (pbmOffers.length === 0) {
      return fail("no_pbm_offer", "server offered no gantry-pbm accepts entry");
    }
    // `payToken()` rather than the raw env value: an unknown id used to be cast
    // straight into `tokenAddress`, where it dereferenced `undefined.addressKey`
    // and was caught by the pre-payment handler below as `transport_error —
    // retrying once is safe`. That sends an operator to the network for what is
    // a one-word typo, and the retry is deterministic failure. `envProblem()`
    // now refuses the run at startup, so by here the id is known good.
    const wantedAsset = gantryTokenAddress(BASE_SEPOLIA_ADDRESSES, payToken());
    const pbmOffer = pbmOffers.find((a) => a.asset.toLowerCase() === wantedAsset.toLowerCase());
    if (!pbmOffer) {
      return fail(
        "no_pbm_offer",
        `server offered no gantry-pbm entry in ${payToken()}; it offered ${pbmOffers
          .map((a) => a.asset)
          .join(", ")}`,
      );
    }
    offer = pbmOffer;

    // 3. Pre-create the intent the signature must bind.
    const intentEndpoint =
      typeof offer.extra["intentEndpoint"] === "string" ? offer.extra["intentEndpoint"] : "/api/pbm/intent";
    const xsgdAmount = typeof offer.extra["xsgdAmount"] === "string" ? offer.extra["xsgdAmount"] : "";
    const intentRes = await fetch(`${env.gantryApi}${intentEndpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The agent declares its currency; the backend quotes in it and the
      // facilitator refuses it if the wallet does not actually hold that token.
      // `payToken()` resolves an unset AGENT_PAY_TOKEN to the vanilla default,
      // which is the same USDC the backend would have defaulted to — stated
      // here rather than left implicit, since the offer above is now selected
      // by the same value.
      body: JSON.stringify({ handle, xsgdAmount, token: payToken() }),
    });
    if (!intentRes.ok) {
      return fail(
        "intent_creation_failed",
        `POST ${intentEndpoint} → ${intentRes.status}: ${await intentRes.text()}`,
      );
    }
    intent = (await intentRes.json()) as PbmIntentResponse;

    // 4. Client-side quote guard: never sign an amount other than the pinned
    //    challenge amount.
    if (intent.amountIn !== offer.amount) {
      return fail("quote_changed", `intent quotes ${intent.amountIn} but the offer pinned ${offer.amount}`);
    }

    // 5. Session key signs SpendAuthorization — the only place the key is used.
    const account = privateKeyToAccount(key);
    signature = await account.signTypedData(reviveSpendAuthorization(intent.typedData, wallet));
  } catch (err) {
    return fail(
      "transport_error",
      `a pre-payment step failed (${err instanceof Error ? err.message : String(err)}). ` +
        "Nothing was paid; retrying once is safe",
    );
  }

  // ------------------------------------------------------------------ the payment
  // From the moment this request is in flight the backend may settle it —
  // a failure here is UNKNOWN, never retryable.
  try {
    const paid = await fetch(orderUrl, {
      method: orderMethod,
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          ...(resource ? { resource } : {}),
          accepted: offer, // echoed verbatim — the middleware subset-matches it
          payload: { pbmWallet: wallet, intentId: intent.intentId, signature },
        }),
      },
    });

    // 7. The receipt travels in PAYMENT-RESPONSE on success AND failure.
    const responseHeader = paid.headers.get(PAYMENT_RESPONSE_HEADER);
    const receipt = responseHeader ? decodePaymentResponseHeader(responseHeader) : null;
    if (paid.ok && receipt?.success) {
      // transaction can legitimately be "" (settle landed after a receipt
      // timeout) — never emit a dangling explorer link for the model to read.
      const txHash = receipt.transaction || undefined;
      return {
        success: true,
        handle,
        sgd,
        amountToken: offer.amount,
        ...(txHash
          ? { txHash, explorerUrl: `${BASESCAN_BASE_URL}/tx/${txHash}` }
          : { note: "settled: tx hash pending the indexer; see the dashboard row" }),
        payer: receipt.payer,
      };
    }
    if (receipt) {
      return fail(receipt.errorReason ?? "settlement_failed", receipt.errorMessage ?? "settlement failed");
    }
    // A verify-stage rejection re-challenges: the fresh 402's error field says why.
    const rechallenge = paid.headers.get(PAYMENT_REQUIRED_HEADER);
    if (rechallenge) {
      const decoded = decodePaymentRequiredHeader(rechallenge);
      return fail(decoded.error ?? "verification_failed", `payment rejected at verify (status ${paid.status})`);
    }
    return fail("outcome_unknown", `paid retry returned ${paid.status} with no payment headers. The payment MAY have settled; do NOT retry, check the dashboard`);
  } catch (err) {
    return fail(
      "outcome_unknown",
      `the paid request failed mid-flight (${err instanceof Error ? err.message : String(err)}). ` +
        "The payment MAY have settled; do NOT retry, check the dashboard",
    );
  }
}
