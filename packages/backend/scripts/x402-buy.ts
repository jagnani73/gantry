/**
 * Standard-interop proof: pays the x402-protected order endpoint with the
 * UNMODIFIED vanilla @x402/fetch client. The paid request itself is pure
 * @x402/fetch; the only Gantry imports are the vendored codec (decoding the
 * 402 challenge and the PAYMENT-RESPONSE receipt for display) and
 * display/explorer helpers.
 *
 * Usage: pnpm --filter @gantry/backend x402:buy [-- --sgd 4.50 --handle ah-hock-chicken-rice]
 *        add `--link` to pay the DUAL-DOOR pay link (GET /pay/:handle) instead
 *        of the agent-only endpoint (POST /api/order/:handle). Same client, same
 *        quote, same settlement — the flag exists so "a person and a machine can
 *        pay the same URL" is something this script proves rather than something
 *        the README asserts.
 * Env: X402_PAYER_KEY (optional; a fresh random key is funded from the demo
 *      funder when unset), GANTRY_API (default http://localhost:4000)
 */
import { parseArgs } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import {
  BASESCAN_BASE_URL,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  formatUnits6,
} from "@gantry/shared";

const { values: args } = parseArgs({
  // pnpm forwards the `--` separator literally — drop it or parseArgs demotes
  // every following option to a positional.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    sgd: { type: "string", default: "4.50" },
    handle: { type: "string", default: "ah-hock-chicken-rice" },
    link: { type: "boolean", default: false },
    discover: { type: "boolean", default: false },
  },
});

const api = process.env.GANTRY_API ?? "http://localhost:4000";
const payerKey = (process.env.X402_PAYER_KEY as `0x${string}` | undefined) ?? generatePrivateKey();
const payer = privateKeyToAccount(payerKey);
// The pay link is a GET because a person opens it in a browser; the agent-only
// endpoint stays a POST. Everything after this line is identical, which is the
// point — the client does not know or care which door it walked through.
const orderUrl = args.link
  ? `${api}/pay/${args.handle}?sgd=${args.sgd}`
  : `${api}/api/order/${args.handle}?sgd=${args.sgd}`;
const method = args.link ? "GET" : "POST";

/**
 * Find a shop the way a machine with no human would: ask for the list.
 *
 * The resource string is paid VERBATIM — not parsed for a handle and rebuilt —
 * because that is the claim being tested. If a listing is not payable exactly as
 * published, discovery is decoration.
 */
async function discoverResource(): Promise<{ url: string; name: string }> {
  const res = await fetch(`${api}/discovery/resources`);
  if (!res.ok) throw new Error(`discovery returned ${res.status}`);
  const listing = (await res.json()) as {
    items: { resource: string; serviceName: string; accepts: { scheme: string }[] }[];
    pagination: { total: number };
  };
  console.log(`discovered ${listing.items.length} of ${listing.pagination.total} shops`);
  const pick =
    listing.items.find((i) => i.resource.includes(`/pay/${args.handle}?`)) ?? listing.items[0];
  if (!pick) throw new Error("the rail listed no shops");
  console.log(`  chose ${pick.serviceName} — ${pick.accepts.map((a) => a.scheme).join(", ")}`);
  return { url: pick.resource, name: pick.serviceName };
}

async function main() {
  console.log(`agent payer: ${payer.address}${process.env.X402_PAYER_KEY ? "" : " (fresh burner)"}`);

  // Discovery replaces the hardcoded URL entirely: nothing below knows a handle.
  const target = args.discover ? (await discoverResource()).url : orderUrl;
  const verb = args.discover ? "GET" : method;

  // 1. Bare request — expect the 402 challenge and decode it with OUR codec.
  const challenge = await fetch(target, { method: verb });
  const header = challenge.headers.get(PAYMENT_REQUIRED_HEADER);
  if (challenge.status !== 402 || !header) {
    throw new Error(`expected 402 + ${PAYMENT_REQUIRED_HEADER}, got ${challenge.status}`);
  }
  const required = decodePaymentRequiredHeader(header);
  const offer = required.accepts[0];
  if (!offer) throw new Error("402 carried an empty accepts[]");
  console.log(`402 challenge decoded:`);
  console.log(`  scheme ${offer.scheme} on ${offer.network}`);
  console.log(`  ${formatUnits6(BigInt(offer.amount), 6)} of ${offer.asset} → payTo ${offer.payTo}`);
  console.log(`  domain ${JSON.stringify(offer.extra)} timeout ${offer.maxTimeoutSeconds}s`);

  // 2. Fund the fresh payer from the demo funder (a real USDC transfer, not a
  //    mint — see services/faucet.ts). Best-effort: a pre-funded
  //    X402_PAYER_KEY needs nothing.
  try {
    const funder = await fetch(`${api}/api/faucet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: payer.address }),
    });
    if (funder.ok) {
      const { funded } = (await funder.json()) as { funded: string };
      console.log(`funder: sent ${formatUnits6(BigInt(funded))} USDC`);
    } else {
      console.log(`funder refused (${funder.status}): ${await funder.text()}. Continuing anyway.`);
    }
  } catch (err) {
    console.log(`funder unreachable (${err instanceof Error ? err.message : err}). Continuing anyway.`);
  }

  // 3. The vanilla client: standard scheme registration, then one call.
  const client = new x402Client().register(offer.network, new ExactEvmScheme(toClientEvmSigner(payer)));
  const payFetch = wrapFetchWithPayment(fetch, client);
  console.log(`paying via unmodified @x402/fetch…`);
  const paid = await payFetch(target, { method: verb });
  console.log(`response: ${paid.status}`);
  if (!paid.ok) {
    // Surface the decoded failure: a rejected retry carries the reason in the
    // fresh challenge's error field (verify) or PAYMENT-RESPONSE (settle).
    // Guard the decodes — a malformed header must not mask the real failure.
    try {
      const rechallenge = paid.headers.get(PAYMENT_REQUIRED_HEADER);
      if (rechallenge) console.error(`verify rejected: ${decodePaymentRequiredHeader(rechallenge).error}`);
      const failedReceipt = paid.headers.get(PAYMENT_RESPONSE_HEADER);
      if (failedReceipt) {
        const r = decodePaymentResponseHeader(failedReceipt);
        console.error(`settle failed: ${r.errorReason}: ${r.errorMessage ?? ""}`);
      }
    } catch (decodeErr) {
      console.error(`(could not decode failure headers: ${decodeErr instanceof Error ? decodeErr.message : decodeErr})`);
    }
    throw new Error(`payment failed: ${await paid.text()}`);
  }
  console.log(`order: ${JSON.stringify(await paid.json())}`);

  // 4. The on-chain receipt travels in the PAYMENT-RESPONSE header.
  const receiptHeader = paid.headers.get(PAYMENT_RESPONSE_HEADER);
  if (!receiptHeader) throw new Error(`200 without ${PAYMENT_RESPONSE_HEADER}`);
  const receipt = decodePaymentResponseHeader(receiptHeader);
  console.log(`settled: success=${receipt.success} payer=${receipt.payer} on ${receipt.network}`);
  console.log(`  ${BASESCAN_BASE_URL}/tx/${receipt.transaction}`);
}

main().catch((err) => {
  // Full object: @x402/fetch wraps causes, and the stack is the only pointer
  // back into the SDK when payload creation fails.
  console.error(err);
  process.exit(1);
});
