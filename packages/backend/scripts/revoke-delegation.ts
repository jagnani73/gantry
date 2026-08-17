/**
 * Revoke an EIP-7702 delegation on the relayer EOA.
 *
 * WHY THIS EXISTS. A wallet UI can upgrade an EOA to a smart account by setting
 * a 7702 delegation, and MetaMask prompts for exactly that during an ordinary
 * transaction — so it can happen to the relayer key without anyone deciding to
 * do it. Base Sepolia then treats the account as delegated and caps how many
 * transactions it may have in flight.
 *
 * That is invisible on every path that sends ONE transaction and waits, which
 * is most of Gantry. It is fatal on the x402 `exact` bridge, which sends the
 * collect and the settle inside a single block window: the second is rejected
 * with `-32000 in-flight transaction limit reached for delegated accounts`,
 * the settlement never lands, and the compensation path refunds the payer.
 * The symptom is a spec-compliant client being unable to pay us — the one beat
 * that proves standards compliance.
 *
 * Revoking is an authorization pointing at the zero address, self-executed. It
 * leaves the relayer ADDRESS unchanged, which is the reason to prefer it over
 * `setRelayer`: that address is baked into `addresses.ts`, the Vercel build and
 * the Render environment, so moving it means rebuilding both hosts.
 *
 * Usage: pnpm --filter @gantry/backend revoke:delegation
 * Reads RELAYER_PRIVATE_KEY and BASE_SEPOLIA_RPC_URL from the backend .env.
 * Prints neither: the key is a secret and the RPC credential lives in the URL
 * path, so the URL is one too.
 */
import { createPublicClient, createWalletClient, http, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config } from "../src/config";

const account = privateKeyToAccount(config.relayerPrivateKey);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(config.rpcUrl),
});

const before = await publicClient.getCode({ address: account.address });
console.log(`relayer      ${account.address}`);

if (!before || before === "0x") {
  console.log("no delegation present — nothing to revoke.");
  process.exit(0);
}

// A 7702 delegation is exactly `0xef0100 || address`. Anything else on an
// account we expect to be an EOA is not something to "fix" by guessing.
if (!before.startsWith("0xef0100")) {
  throw new Error(`relayer holds code that is not a 7702 delegation: ${before}`);
}
console.log(`delegated to 0x${before.slice(8)}`);

// executor: "self" — the authority is also the sender, so the authorization
// takes nonce+1: the transaction carrying it consumes the current nonce first.
const authorization = await walletClient.signAuthorization({
  account,
  contractAddress: zeroAddress,
  executor: "self",
});

const hash = await walletClient.sendTransaction({
  authorizationList: [authorization],
  to: account.address,
  value: 0n,
});
console.log(`\nrevocation   ${hash}`);
console.log(`             https://sepolia.basescan.org/tx/${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
if (receipt.status !== "success") {
  throw new Error(`revocation reverted in block ${receipt.blockNumber}`);
}

// Read it back rather than trusting the receipt: a mined transaction says the
// authorization was processed, not that the code is gone.
const after = await publicClient.getCode({ address: account.address });
if (after && after !== "0x") {
  throw new Error(`delegation still present after revocation: ${after}`);
}
console.log(`\nrevoked in block ${receipt.blockNumber} — the relayer is a plain EOA again.`);
