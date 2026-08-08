import { Router } from "express";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { config } from "../config";
import { resetIndexer } from "../indexer";
import { broadcast } from "../sse";
import { ApiError } from "../errors";
import { topUpFunder, topUpPbmWallet } from "../services/funder";

export const adminRouter = Router();

function requireAdminToken(token: string | undefined): void {
  if (token !== config.adminToken) {
    throw new ApiError(401, "Unauthorized", "bad or missing x-admin-token");
  }
}

/**
 * There is deliberately no policy write here any more. `setPolicy` and `revoke`
 * are `onlyOwner` and agent wallets are owned by the PAYER, so no server key can
 * arm one — the rehearsal re-arm moved into `demo:reset`, which signs with the
 * demo payer's own key.
 */

adminRouter.post("/api/admin/reset", async (req, res) => {
  requireAdminToken(req.get("x-admin-token"));
  await resetIndexer();
  broadcast("reset", null, { at: Math.floor(Date.now() / 1000) });
  res.json({ ok: true });
});

/** demo-reset's funder check: swaps ETH for USDC when the funder runs low.
 * Admin-gated and deliberately out of the payment path — see services/funder.ts. */
adminRouter.post("/api/admin/funder/topup", async (req, res) => {
  requireAdminToken(req.get("x-admin-token"));
  res.json(await topUpFunder());
});

/**
 * demo-reset's agent-wallet top-up. Admin-gated and cooldown-free, so one reset
 * always leaves the wallet able to run both agent beats.
 *
 * `wallet` is a REQUIRED body field rather than a pinned constant. Wallets are
 * created on-chain by their payer-owner now, so which one matters this run is
 * known only to the caller that just provisioned it — and falling back to the
 * historical demo wallet would move real USDC to an address nothing spends from
 * and report success. That is precisely the failure this route exists to
 * prevent: an empty wallet makes the S$4 GadgetHub beat die at the facilitator's
 * balance pre-check as insufficient_funds instead of reaching CategoryNotAllowed.
 */
adminRouter.post("/api/admin/wallet/topup", async (req, res) => {
  requireAdminToken(req.get("x-admin-token"));
  res.json(await topUpPbmWallet(requireWallet(req.body?.wallet)));
});

/** Shape only, then normalised to the checksummed spelling the chain returns —
 * same rule as routes/agents.ts. The zero address passes `isAddress`, and a
 * transfer to it is a burn, so it is refused by name rather than left to revert. */
function requireWallet(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new ApiError(400, "ValidationError", "body.wallet must be a 0x-prefixed address");
  }
  const wallet = getAddress(value);
  if (wallet === zeroAddress) {
    throw new ApiError(400, "ValidationError", "body.wallet cannot be the zero address");
  }
  return wallet;
}
