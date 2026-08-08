import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { demoKey } from "./env";

/**
 * The pinned demo account, when one is configured.
 *
 * It used to be a per-device burner generated into localStorage. That stopped
 * making sense once agents became payer-owned on-chain: a fresh random address
 * owns no agent wallets and has no payment history, so the wallet, activity and
 * agent screens would all be permanently empty for it. One pinned account also
 * means the phone that scans the printed QR and the laptop showing the payer app
 * are the same payer — the payment made on one appears in the other.
 *
 * Throws rather than falling back: every caller has already checked
 * `demoAccountEnabled()`, and silently signing with some other key is the one
 * outcome that must never happen.
 */
export function getDemoAccount(): PrivateKeyAccount {
  const key = demoKey();
  if (!key) {
    throw new Error("no demo account configured — NEXT_PUBLIC_DEMO_KEY is unset or malformed");
  }
  return privateKeyToAccount(key);
}
