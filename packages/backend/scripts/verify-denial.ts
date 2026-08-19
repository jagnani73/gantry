/**
 * Re-derive a refusal from public state, without trusting us.
 *
 * A Gantry denial is relayer-ATTESTED: `IntentDenied` carries bytes the relayer
 * supplies, and `authorizeSpend` checks the agent's signature first — a
 * signature never stored or emitted — so anyone re-simulating the call gets
 * `InvalidAgentSignature` whatever the real reason was. The record is therefore
 * not reproducible as-is, and the project says so out loud.
 *
 * This closes the half that can be closed. Given one cancel transaction — the
 * Basescan link a receipt already shows — it reads the policy, the day's spend,
 * the wallet balance and the merchant's category AT THAT BLOCK, recomputes what
 * `authorizeSpend` would have done, and compares that to the reason we emitted.
 * Nothing here asks a Gantry API for an opinion: every input is a public getter
 * or a log, so a stranger with an RPC URL gets the same answer.
 *
 * It can CONTRADICT us, which is the point — a checker that can only ever agree
 * proves nothing. See `auditDenial` and its fabricated-claim test.
 *
 * Usage: pnpm --filter @gantry/backend verify:denial -- --tx 0x<cancelTxHash>
 *        (no --tx: reads the newest denial from a running backend, for the demo)
 */
import { parseArgs } from "node:util";
import { decodeEventLog, erc20Abi, type Address, type Hex } from "viem";
import {
  BASESCAN_BASE_URL,
  CATEGORY_LABELS,
  SIGNATURE_IS_NOT_CHECKED,
  agentPbmWalletAbi,
  auditDenial,
  checkSpend,
  decodeRawError,
  formatUnits6,
  gantryCoreAbi,
  type DecodedGantryError,
  type PolicyVerdict,
} from "@gantry/shared";
import { publicClient } from "../src/chain";
import { config } from "../src/config";

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { tx: { type: "string" }, api: { type: "string", default: "http://localhost:4000" } },
});

/** The newest denial this backend knows about — a convenience for the demo, and
 * the ONLY step that trusts a Gantry API. Everything after it is chain reads. */
async function newestCancelTx(): Promise<Hex> {
  // `/api/denials` requires a wallet and there is no "all wallets" list to ask
  // for — agent wallets are payer-owned by design. So find one the way anyone
  // could: the payer of an agent-door settlement IS the wallet contract.
  const res = await fetch(`${args.api}/api/settlements?limit=50`);
  if (!res.ok) throw new Error(`could not reach ${args.api} (${res.status}); pass --tx instead`);
  const { rows } = (await res.json()) as {
    rows: { payer: Address; door: string; bridged?: boolean }[];
  };

  // NOT bridged. "Agent door" is not the same question as "paid by a wallet":
  // an `exact` payment hops through the relayer, so its on-chain payer is the
  // relayer and never a PBM wallet. `bridged` exists on the wire to say exactly
  // that, and this used to ignore it — which was survivable only while bridged
  // settlements were rare. They are not: --link, --discover and every vanilla
  // interop run produces one, so the newest agent-door rows are now routinely
  // all bridged and this resolved to the relayer, an address with no denials.
  //
  // Every candidate is tried rather than just the newest, because a wallet
  // having settled recently says nothing about whether it was ever refused.
  const candidates = rows.filter((r) => r.door === "agent" && !r.bridged).map((r) => r.payer);
  const seen = new Set<string>();
  for (const wallet of candidates) {
    const key = wallet.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const denials = await fetch(`${args.api}/api/denials?wallet=${wallet}`);
    if (!denials.ok) continue;
    const body = (await denials.json()) as { rows: { cancelTxHash: Hex | null }[] };
    const withCancel = body.rows.find((r) => r.cancelTxHash);
    if (withCancel?.cancelTxHash) return withCancel.cancelTxHash;
  }
  throw new Error(
    candidates.length === 0
      ? "no non-bridged agent-door payment found to locate a wallet; pass --tx"
      : `checked ${seen.size} wallet(s) and none has a denial with a cancel transaction; pass --tx`,
  );
}

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main() {
  const txHash = (args.tx as Hex | undefined) ?? (await newestCancelTx());
  console.log(`cancel tx  ${txHash}`);
  console.log(`           ${BASESCAN_BASE_URL}/tx/${txHash}\n`);

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("that transaction reverted; it recorded nothing");
  const block = receipt.blockNumber;

  // The denial, decoded from the transaction's own logs — not from our database.
  const denied = receipt.logs
    .map((log) => {
      try {
        const ev = decodeEventLog({ abi: gantryCoreAbi, data: log.data, topics: log.topics });
        return ev.eventName === "IntentDenied" ? (ev.args as unknown as DeniedArgs) : null;
      } catch {
        return null;
      }
    })
    .find((x): x is DeniedArgs => x !== null);
  if (!denied) throw new Error("no IntentDenied in that transaction's logs");

  // A denial's reason is the wallet's VERBATIM revert data, so it decodes to a
  // custom error in the normal case. A string or unknown shape is not a policy
  // dimension and `auditDenial` will rightly call it unprovable.
  const claimed = decodeRawError(denied.reason);
  const claimedName = claimedErrorName(claimed);

  // Everything below is read AT THE DENIAL'S BLOCK. Reading at head would answer
  // a different question — the demo re-arms its policy between runs, so current
  // state routinely disagrees with the state that decided this refusal.
  const intent = await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "getIntent",
    args: [denied.intentId],
    blockNumber: block,
  });
  const merchant = await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "merchants",
    args: [intent.merchantId],
    blockNumber: block,
  });
  const [policy, spentToday, balance, blockInfo] = await Promise.all([
    publicClient.readContract({
      address: denied.wallet,
      abi: agentPbmWalletAbi,
      functionName: "policy",
      blockNumber: block,
    }),
    publicClient.readContract({
      address: denied.wallet,
      abi: agentPbmWalletAbi,
      functionName: "spentToday",
      blockNumber: block,
    }),
    publicClient.readContract({
      address: intent.tokenIn,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [denied.wallet],
      blockNumber: block,
    }),
    publicClient.getBlock({ blockNumber: block }),
  ]);

  const categoryId = Number(merchant[1]);
  const verdict: PolicyVerdict = checkSpend(
    {
      expiry: Number(policy[2]),
      categoryBitmap: policy[3],
      perTxCap: policy[1],
      dailyCap: policy[0],
      spentToday,
      balance,
    },
    { categoryId, amount: intent.amountIn, atUnixSeconds: Number(blockInfo.timestamp) },
  );

  console.log(`read at block ${block} (${new Date(Number(blockInfo.timestamp) * 1000).toISOString()})\n`);
  line("wallet", denied.wallet);
  line("merchant", `${merchant[2]} · category ${categoryId} (${CATEGORY_LABELS[categoryId] ?? "?"})`);
  line("amount", `${formatUnits6(intent.amountIn, 6)} of ${intent.tokenIn}`);
  console.log();

  for (const check of verdict.checks) {
    const mark = check.ok ? "PASS" : "FAIL";
    console.log(`  ${mark}  ${check.dimension.padEnd(9)} ${check.actual}`);
    console.log(`        ${" ".repeat(9)} needs ${check.required}`);
  }

  console.log();
  line("we recorded", claimedName);
  line("public state says", verdict.errorName ?? "the spend would have been ALLOWED");

  const audit = auditDenial(claimedName, verdict);
  console.log();
  if (audit === "consistent") {
    console.log(`VERDICT: CONSISTENT — the wallet would have refused this, for the reason we published.`);
  } else if (audit === "contradicted") {
    console.log(`VERDICT: CONTRADICTED — public state does not support the reason we published.`);
  } else {
    console.log(`VERDICT: UNPROVABLE from public state — "${claimedName}" is not a policy dimension.`);
  }
  console.log(`\nNote: ${SIGNATURE_IS_NOT_CHECKED}.`);
  process.exitCode = audit === "contradicted" ? 1 : 0;
}

interface DeniedArgs {
  intentId: Hex;
  wallet: Address;
  reason: Hex;
}

/** The reason as a NAME. Undecodable bytes and Circle's string reverts are not
 * policy dimensions, so they flow through as themselves and `auditDenial` calls
 * them unprovable rather than pretending to check them. */
function claimedErrorName(decoded: DecodedGantryError | null): string {
  if (decoded === null) return "undecodable";
  if (decoded.kind === "custom") return decoded.name;
  if (decoded.kind === "string") return decoded.reason;
  return decoded.message;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
