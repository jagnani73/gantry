# Configuration reference

Every environment variable, the values it accepts, and what each value does.

Behaviour that depends on more than one variable cannot be expressed in a
single table — those combinations are in [Interactions](#interactions) below.

Claims are traced from the code, with `file:line` references so they can be
re-checked as the code moves.

| File | Read by |
|---|---|
| `packages/backend/.env` | backend |
| `packages/web/.env.local` | web |
| `packages/agent/.env` | agent CLI |

---

## Backend — `packages/backend/.env`

#### `CHAIN_ID`

| Value | Behaviour |
|---|---|
| `84532` *(default)* | Base Sepolia. Addresses come from the pins in `@gantry/shared`. |
| `31337` | Local Anvil. Requires the four address overrides below; `realUsdc` becomes `null`. |
| anything else | Boot fails. |

#### `BASE_SEPOLIA_RPC_URL`

| Value | Behaviour |
|---|---|
| one URL | Primary RPC. `https://sepolia.base.org` is appended as fallback. |
| comma-separated URLs | Tried in order, first is primary. The public node is appended unless already listed. |
| unset, `CHAIN_ID=84532` | Boot fails. |
| unset, `CHAIN_ID=31337` | Ignored — `ANVIL_RPC_URL` is used. |

#### `BASE_SEPOLIA_WS_URL`

| Value | Behaviour |
|---|---|
| a `wss://` URL | The indexer's live event feed. |
| unset | Derived from the **first** `BASE_SEPOLIA_RPC_URL` entry with `https://` → `wss://`. |

No fallback exists for this client. If it drops, the 15s `getLogs` sweep still
carries correctness; only latency degrades.

#### `RELAYER_PRIVATE_KEY`

| Value | Behaviour |
|---|---|
| `0x` + 64 hex | The only gas key in the system — pays for every settlement, registration and faucet mint. |
| missing or malformed | Boot fails. |

An empty ETH balance is not a boot failure — it surfaces later as failed
transactions.

#### `ADMIN_TOKEN`

| Value | Behaviour |
|---|---|
| ≥ 8 chars | Authenticates the admin reset route. |
| shorter or unset | Boot fails. |

#### `FAUCET_ENABLED`

| Value | Behaviour |
|---|---|
| `1` *(default)* | `POST /api/faucet` mints 100 MUSDC, 60s cooldown per address. |
| `0` | Route returns 403 `FaucetDisabled`. |

#### `POLICY_ADMIN_ENABLED`

| Value | Behaviour |
|---|---|
| `1` *(default)* | `POST /api/policy/revoke` allowed, 30s cooldown regardless. |
| `0` | Route returns 403. |

#### `DEFAULT_TOKEN`

| Value | Behaviour |
|---|---|
| `MUSDC` *(default)* | Fallback token for `POST /api/intents` when the request omits `token` (`services/intents.ts:62`). |
| `USDC` | Same, real Circle USDC. Boot fails on `CHAIN_ID=31337`. |
| `XSGD` | Same, XSGD-direct settlement. |

Rarely applies — the payer page and `e2e:pay` both send an explicit `token`.

#### `ORDER_TOKEN`

| Value | Behaviour |
|---|---|
| `MUSDC` | Agent door asset: the x402 402 offer, `POST /api/pbm/intent`, and the policy panel's display token. |
| `USDC` | Same, real USDC. Boot fails on `CHAIN_ID=31337`. |
| unset *(default)* | `USDC` when the chain has real USDC, else `MUSDC`. |

Must match what the PBM wallet actually holds; `demo:reset` warns when it does not.

#### `CORS_ORIGIN`

| Value | Behaviour |
|---|---|
| `*` *(default)* | Any origin may call the API. |
| an origin | Restricted to it. |

#### `INTENT_TTL_SECONDS`

| Value | Behaviour |
|---|---|
| `600` *(default)* | Quote lifetime from block timestamp. `validBefore` is this + 120s. |
| ≥ 60 | As given. Below 60 boot fails. |

#### `PORT` · `DB_PATH`

| Variable | Default | Behaviour |
|---|---|---|
| `PORT` | `4000` | HTTP listen port. |
| `DB_PATH` | `./gantry.db` | SQLite cache location, resolved relative to the backend package. The file is disposable — the chain is the source of truth. |

#### `PBM_WALLET_ADDRESS`

| Value | Behaviour |
|---|---|
| unset *(default)* | The demo wallet pinned in `@gantry/shared`. |
| an address | Overrides it — for a local chain or a fresh deploy. |

#### `ANVIL_RPC_URL`, `GANTRY_CORE_ADDRESS`, `FIXED_RATE_SWAP_ADDRESS`, `MOCK_USDC_ADDRESS`, `MOCK_XSGD_ADDRESS`

| Value | Behaviour |
|---|---|
| set, `CHAIN_ID=31337` | Used. All four addresses are required at 31337 or boot fails. |
| any, `CHAIN_ID=84532` | Ignored — Base Sepolia addresses come from the pins. |

---

## Web — `packages/web/.env.local`

#### `NEXT_PUBLIC_BURNER`

| Value | Behaviour |
|---|---|
| `0` or unset *(default)* | Connected wallet, unless `?burner=1` is in the URL. |
| `1` | Burner always, on every page load. `?burner=0` does not exist. |

#### `NEXT_PUBLIC_BURNER_KEY`

Only consulted when the burner is active.

| Value | Behaviour |
|---|---|
| `0x` + 64 hex | That account on every device and session. Fund it once ahead of time. |
| unset | A key is generated and persisted in `localStorage` under `gantry.burner.key` — one wallet per browser. |
| malformed | **Silently treated as unset** (`lib/env.ts:17`) — falls through to the localStorage key rather than erroring. |

#### `NEXT_PUBLIC_PAY_TOKEN`

| Value | Behaviour |
|---|---|
| `USDC` *(default)* | Connected-wallet path pays in real USDC. |
| `MUSDC` / `XSGD` | Connected-wallet path pays in that token. |
| any value, burner active | **Ignored** — the burner is hardcoded to MUSDC (`pay-client.tsx:115`). |

#### `NEXT_PUBLIC_APP_URL`

| Value | Behaviour |
|---|---|
| `http://localhost:3000` *(default)* | Encoded into the printed QR as `<value>/pay/<handle>` (`app/qr/[handle]/page.tsx:10`). |
| a LAN IP or domain | Same. A QR generated against one host is unusable from another. |

#### `NEXT_PUBLIC_BACKEND_URL`

| Value | Behaviour |
|---|---|
| `http://localhost:4000` *(default)* | Target for every browser-originated API call and the SSE feed. |
| wrong value | Dashboard shows "disconnected — check backend URL" rather than hanging. |

#### `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`

| Value | Behaviour |
|---|---|
| a project id | WalletConnect modal works. |
| unset | Falls back to a placeholder; the burner and injected-wallet paths still work. |

---

## Agent — `packages/agent/.env`

#### `AGENT_SESSION_KEY`

| Value | Behaviour |
|---|---|
| the key matching the wallet's on-chain `agentSigner` | Payments authorize successfully. |
| any other valid key | Every payment fails `InvalidAgentSignature`. |
| missing or malformed | `payMerchant` returns `invalid_request`; nothing is sent. |

#### `GOOGLE_GENERATIVE_AI_API_KEY`

| Value | Behaviour |
|---|---|
| unset | Scripted narration immediately, no LLM call (`index.ts:126`). |
| set | Live model, with a scripted fallback if nothing streams in time. |

Both modes execute identical wire traffic — same tools, same HTTP, same on-chain
settlement. Only the narration differs.

#### `AGENT_LLM_TIMEOUT_MS`

| Value | Behaviour |
|---|---|
| `8000` *(default)* | Time with no *real* stream part before falling back. Synthetic `start` parts are ignored, or the timer would defuse itself ~5ms in. |
| other | As given. |

The fallback only engages while `toolCallsStarted === 0`. Once a tool has fired
the run refuses to fall back and exits, so a payment can never execute twice.

#### `AGENT_LLM_MODEL` · `GANTRY_API` · `PBM_WALLET_ADDRESS`

| Variable | Default | Behaviour |
|---|---|---|
| `AGENT_LLM_MODEL` | `gemini-flash-latest` | Model id passed to the provider. |
| `GANTRY_API` | `http://localhost:4000` | Backend the agent calls. |
| `PBM_WALLET_ADDRESS` | pinned demo wallet | Override for a local chain or fresh deploy. |

---

## Interactions

### Which key signs a human payment

Resolved at `pay-client.tsx:63` as `burnerEnvEnabled() || query.get("burner") === "1"`.

| `NEXT_PUBLIC_BURNER` | URL | `NEXT_PUBLIC_BURNER_KEY` | Signing key |
|---|---|---|---|
| `0`/unset | `/pay/<handle>` | any | connected wallet |
| `0`/unset | `?burner=1` | valid | the fixed key |
| `0`/unset | `?burner=1` | unset/malformed | per-browser localStorage key |
| `1` | any | valid | the fixed key |
| `1` | any | unset/malformed | per-browser localStorage key |

### Burner funding

`pay-client.tsx:145-165`, burner path only.

| Balance vs `amountIn` | `FAUCET_ENABLED` | Result |
|---|---|---|
| sufficient | any | Straight to signing, no faucet call. |
| insufficient | `1` | `funding` step → mint 100 MUSDC → poll balance 10× 1.5s → sign, or fail "faucet funds not visible yet" after ~15s. |
| insufficient | `0` | Flow stops with `FaucetDisabled` — the payment cannot proceed. |

### Which token a payment uses

| Path | Token |
|---|---|
| burner | always `MUSDC` |
| connected wallet | `NEXT_PUBLIC_PAY_TOKEN` |
| agent door (`exact` and `gantry-pbm`) | `ORDER_TOKEN` |
| any request omitting `token` | `DEFAULT_TOKEN` |

### Amount cap

| Path | Cap |
|---|---|
| burner | S$130 (`pay-client.tsx:242`) — follows from the faucet minting 100 MUSDC |
| connected wallet | S$9999 |

---

## Resulting flows

| Flow | Condition | Characteristics |
|---|---|---|
| Burner, fixed key | burner on + valid `NEXT_PUBLIC_BURNER_KEY` | deterministic account, no faucet round-trip if pre-funded |
| Burner, per-device | burner on, no valid key | localStorage key, faucet-funded on demand |
| Connected wallet | burner off | real wallet, chain-switch prompt, no faucet |
| x402 `exact` | vanilla client against the 402 route | on-chain payer is the relayer — one custodial hop |
| `gantry-pbm` | agent CLI or `e2e:pbm` | on-chain payer is the PBM wallet; policy enforced by contract revert |
| Live narration | LLM key set | model decides and narrates; timeout falls back |
| Scripted narration | key unset, or fallback fired | identical wire traffic; announced on stderr |

---

## Sharp edges

1. Web variables are read at build time — restart after editing.
2. `NEXT_PUBLIC_BURNER=1` cannot be overridden off per request.
3. A malformed `NEXT_PUBLIC_BURNER_KEY` degrades silently to a localStorage key.
4. `FAUCET_ENABLED=0` breaks the burner flow for any unfunded wallet.
5. Cooldowns differ in scope: faucet per **address**, onboarding per **IP**,
   revoke per **instance**.
6. The onboarding cooldown is in-process and survives `demo:reset`.
7. `ORDER_TOKEN` must match what the PBM wallet holds.
8. `AGENT_SESSION_KEY` must match the wallet's on-chain `agentSigner`.
9. `packages/contracts/.env` defines its own `BASE_SEPOLIA_RPC_URL` and must
   keep a **single** URL — foundry cannot parse the comma-separated form.
