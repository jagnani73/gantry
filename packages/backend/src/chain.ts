import { createPublicClient, createWalletClient, fallback, http, webSocket } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  TOKENS,
  tokenAddress,
  type Eip712TokenDomain,
  type TokenId,
} from "@gantry/shared";
import { config } from "./config";

export const chain = baseSepolia;

/**
 * Ordered fallback across every configured RPC. Ranking is deliberately NOT
 * enabled: it would let viem migrate to a lower-latency provider mid-demo based
 * on background samples, so a payment could land on the rate-limited public
 * node while the paid provider is healthy. Ordered failover only moves on a
 * real error, which is the behaviour we can rehearse.
 */
const rpcTransport = () => fallback(config.rpcUrls.map((url) => http(url)));

export const publicClient = createPublicClient({
  chain,
  transport: rpcTransport(),
});

/** Dedicated WS client — used only by the indexer's watchContractEvent. */
export const wsClient = createPublicClient({
  chain,
  transport: webSocket(config.wsUrl),
});

export const relayerAccount = privateKeyToAccount(config.relayerPrivateKey);

export const walletClient = createWalletClient({
  chain,
  account: relayerAccount,
  transport: rpcTransport(),
});

const domainReadAbi = [
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "version",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
] as const;

/** Live-read EIP-712 domains, asserted against the pinned expected values at boot. */
const tokenDomains = new Map<TokenId, Eip712TokenDomain>();

export async function assertTokenDomains(): Promise<void> {
  const ids: TokenId[] = ["MUSDC", "XSGD", ...(config.addresses.realUsdc ? (["USDC"] as const) : [])];
  for (const id of ids) {
    const address = tokenAddress(config.addresses, id);
    const [name, version] = await Promise.all([
      publicClient.readContract({ address, abi: domainReadAbi, functionName: "name" }),
      publicClient.readContract({ address, abi: domainReadAbi, functionName: "version" }),
    ]);
    const expected = TOKENS[id].eip712;
    if (name !== expected.name || version !== expected.version) {
      throw new Error(
        `EIP-712 domain drift for ${id} at ${address}: chain reports ("${name}", "${version}"), expected ("${expected.name}", "${expected.version}")`,
      );
    }
    tokenDomains.set(id, { name, version, chainId: config.chainId, verifyingContract: address });
  }
  console.log(`token domains verified: ${ids.join(", ")}`);
}

export function tokenDomain(id: TokenId): Eip712TokenDomain {
  const domain = tokenDomains.get(id);
  if (!domain) throw new Error(`token domain not initialised for ${id}`);
  return domain;
}
