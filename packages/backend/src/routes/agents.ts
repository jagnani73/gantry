import { Router } from "express";
import { getAddress, isAddress, type Address } from "viem";
import { ApiError } from "../errors";
import { getAgent, listAgents, type AgentFilter } from "../services/agents";

/**
 * GET /api/agents?owner=&agentSigner=  — payer-owned PBM wallets.
 * GET /api/agents/:wallet              — one of them.
 *
 * Read-only, and there is no write sibling. `setPolicy` and `revoke` are
 * `onlyOwner` and the owner is the payer, so the payer's own key signs them —
 * which is why POST /api/policy and its kill switch were deleted outright
 * rather than gated harder.
 */
export const agentsRouter = Router();

/**
 * Addresses arrive here typed, pasted or echoed from a previous response, so a
 * lowercase one is accepted (viem's strict check does, and refusing it would
 * break every hand-written URL). Normalised to the checksummed spelling the
 * chain returns so the filter and the response agree on one form.
 */
function parseAddress(value: unknown, what: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new ApiError(400, "ValidationError", `${what} must be a 0x-prefixed address`);
  }
  return getAddress(value);
}

agentsRouter.get("/api/agents", async (req, res) => {
  const filter: AgentFilter = {
    ...(req.query.owner === undefined ? {} : { owner: parseAddress(req.query.owner, "owner") }),
    ...(req.query.agentSigner === undefined
      ? {}
      : { agentSigner: parseAddress(req.query.agentSigner, "agentSigner") }),
  };
  if (!filter.owner && !filter.agentSigner) {
    // An unfiltered list would be every wallet the permissionless factory ever
    // made — strangers' agents, their caps and their balances — behind a URL
    // with no arguments. Requiring a filter is not authentication (the chain is
    // public either way); it is refusing to build the aggregate.
    throw new ApiError(400, "ValidationError", "pass owner and/or agentSigner");
  }
  res.json(await listAgents(filter));
});

agentsRouter.get("/api/agents/:wallet", async (req, res) => {
  res.json(await getAgent(parseAddress(req.params.wallet, "wallet")));
});
