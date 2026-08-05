/**
 * Standard-interop proof: pays the x402-protected order endpoint with the
 * UNMODIFIED vanilla @x402/fetch client — zero Gantry code on the payment
 * path. The script's only Gantry imports are the vendored codec (to pretty-
 * print the 402 challenge) and addresses for the faucet fallback.
 *
 * Usage: pnpm --filter @gantry/backend x402:buy [-- --sgd 19.50 --handle ah-hock-chicken-rice]
 * Env: X402_PAYER_KEY (optional; fresh random key when unset — fine for MUSDC,
 *      real Circle USDC needs a pre-funded key), GANTRY_API (default http://localhost:4000)
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
  options: {
    sgd: { type: "string", default: "19.50" },
    handle: { type: "string", default: "ah-hock-chicken-rice" },
  },
});

const api = process.env.GANTRY_API ?? "http://localhost:4000";
const payerKey = (process.env.X402_PAYER_KEY as `0x${string}` | undefined) ?? generatePrivateKey();
const payer = privateKeyToAccount(payerKey);
const orderUrl = `${api}/api/order/${args.handle}?sgd=${args.sgd}`;

async function main() {
  console.log(`agent payer: ${payer.address}${process.env.X402_PAYER_KEY ? "" : " (fresh burner)"}`);

  // 1. Bare request — expect the 402 challenge and decode it with OUR codec.
  const challenge = await fetch(orderUrl, { method: "POST" });
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

  // 2. Fund the burner when the offer is in MockUSDC; real USDC keys must
  //    arrive pre-funded (Circle faucet).
  const faucet = await fetch(`${api}/api/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: payer.address }),
  });
  if (faucet.ok) {
    const minted = (await faucet.json()) as { minted: string };
    console.log(`faucet: minted ${formatUnits6(BigInt(minted.minted))} MUSDC`);
  } else {
    console.log(`faucet unavailable (${faucet.status}) — assuming pre-funded payer`);
  }

  // 3. The vanilla client: standard scheme registration, then one call.
  const network = offer.network as `${string}:${string}`; // owned type is string; SDK wants CAIP-2
  const client = new x402Client().register(network, new ExactEvmScheme(toClientEvmSigner(payer)));
  const payFetch = wrapFetchWithPayment(fetch, client);
  console.log(`paying via unmodified @x402/fetch…`);
  const paid = await payFetch(orderUrl, { method: "POST" });
  console.log(`response: ${paid.status}`);
  if (!paid.ok) {
    // Surface the decoded failure: a rejected retry carries the reason in the
    // fresh challenge's error field (verify) or PAYMENT-RESPONSE (settle).
    const rechallenge = paid.headers.get(PAYMENT_REQUIRED_HEADER);
    if (rechallenge) console.error(`verify rejected: ${decodePaymentRequiredHeader(rechallenge).error}`);
    const failedReceipt = paid.headers.get(PAYMENT_RESPONSE_HEADER);
    if (failedReceipt) {
      const r = decodePaymentResponseHeader(failedReceipt);
      console.error(`settle failed: ${r.errorReason} — ${r.errorMessage ?? ""}`);
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
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
