import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { burnerEnvKey } from "./env";

const STORAGE_KEY = "gantry.burner.key";

/**
 * Two key sources, one signing path:
 *  - NEXT_PUBLIC_BURNER holds a key → that pre-funded deterministic account;
 *  - NEXT_PUBLIC_BURNER=1 → a per-device key persisted in localStorage, funded
 *    on demand via the backend faucet.
 * Call only from the client (effects/handlers) — never during render.
 */
export function getBurnerAccount(): PrivateKeyAccount {
  const envKey = burnerEnvKey();
  if (envKey) return privateKeyToAccount(envKey);

  let key = window.localStorage.getItem(STORAGE_KEY) as `0x${string}` | null;
  if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) {
    key = generatePrivateKey();
    window.localStorage.setItem(STORAGE_KEY, key);
  }
  return privateKeyToAccount(key);
}
