# Configuration reference

The environment variables that change **what the app does** — which key signs a
payment, which token moves, whether the agent thinks for itself.

Plumbing is deliberately not here: chain selection, RPC and WebSocket URLs,
ports, database path, CORS, and the keys themselves are documented inline in the
three `.env.example` files. Nothing below is needed to *run* the app — only to
change how it behaves.

Claims are traced from the code, with `file:line` references so they can be
re-checked as the code moves.

---

## Which key signs a human payment

The payer page has two key sources behind one signing path.

#### `NEXT_PUBLIC_BURNER`

One knob: the value *is* the burner's key, and holding one is what turns the
burner on.

| Value | Behaviour |
|---|---|
| unset or `0` *(default)* | Burner off — connected wallet, unless `?burner=1` is in the URL. |
| `0x` + 64 hex | Burner on, pinned to that account on every device and session. Fund it once ahead of time. |
| anything else | Burner off, with a `console.warn`. A malformed value never quietly changes which account signs. |

### Combined with `?burner=1`

Resolved at `pay-client.tsx:63` as `burnerEnvEnabled() || query.get("burner") === "1"`.

| `NEXT_PUBLIC_BURNER` | URL | Signing key |
|---|---|---|
| unset / `0` / malformed | `/pay/<handle>` | connected wallet |
| unset / `0` / malformed | `?burner=1` | per-browser key from `localStorage` (`gantry.burner.key`), faucet-funded |
| a `0x` key | any | that fixed account |

There is no `?burner=0` — a configured key cannot be turned off per request.

Note the printed QR encodes `/pay/<handle>` with no query string, so a phone
scanning it gets the burner **only** when `NEXT_PUBLIC_BURNER` holds a key.

### Funding and cap

Burner only (`pay-client.tsx:145-165`). The connected wallet is never funded and
must already hold the token.

| Balance vs `amountIn` | `FAUCET_ENABLED` | Result |
|---|---|---|
| sufficient | any | Straight to signing, no faucet call. |
| insufficient | `1` | `funding` step → mint 100 MUSDC → poll balance 10× 1.5s → sign, or fail "faucet funds not visible yet" after ~15s. |
| insufficient | `0` | Stops with `FaucetDisabled` — the payment cannot proceed. |

Amount cap: **S$130** on the burner, S$9999 on a connected wallet
(`pay-client.tsx:242`). The cap follows from the faucet minting 100 MUSDC.

---

## Which token moves

Three variables, three different paths.

#### `DEFAULT_TOKEN`

| Value | Behaviour |
|---|---|
| `MUSDC` *(default)* | Fallback for `POST /api/intents` when the request omits `token` (`services/intents.ts:62`). |
| `USDC` | Same, real Circle USDC. |
| `XSGD` | Same, XSGD-direct settlement. |

Rarely applies — the payer page and `e2e:pay` both send an explicit `token`.

#### `ORDER_TOKEN`

| Value | Behaviour |
|---|---|
| `MUSDC` | Agent-door asset: the x402 402 offer, `POST /api/pbm/intent`, and the policy panel's display token. |
| `USDC` | Same, real USDC. |
| unset *(default)* | `USDC` when the chain has real USDC, else `MUSDC`. |

Must match what the PBM wallet actually holds, or every agent payment fails on
balance; `demo:reset` warns when it diverges.

#### `NEXT_PUBLIC_PAY_TOKEN`

| Value | Behaviour |
|---|---|
| `USDC` *(default)* | Connected-wallet path pays in real USDC. |
| `MUSDC` / `XSGD` | Connected-wallet path pays in that token. |
| any value, burner active | **Ignored** — the burner is hardcoded to MUSDC (`pay-client.tsx:115`), because the faucet can only mint MUSDC. |

### Combined

| Path | Token |
|---|---|
| burner | always `MUSDC` |
| connected wallet | `NEXT_PUBLIC_PAY_TOKEN` |
| agent door (`exact` and `gantry-pbm`) | `ORDER_TOKEN` |
| any request omitting `token` | `DEFAULT_TOKEN` |

---

## Whether the agent thinks for itself

#### `GOOGLE_GENERATIVE_AI_API_KEY`

| Value | Behaviour |
|---|---|
| unset | Scripted narration immediately, no LLM call (`index.ts:126`). |
| set | Live model, with a scripted fallback if nothing streams in time. |

Both modes execute **identical wire traffic** — same tools, same HTTP, same
on-chain settlement. Only the narration differs, which is what lets the
honest-labels list call the payment real either way.

#### `AGENT_LLM_TIMEOUT_MS`

| Value | Behaviour |
|---|---|
| `8000` *(default)* | Time with no *real* stream part before falling back. Synthetic `start` parts are ignored, or the timer would defuse itself ~5ms in. |
| other | As given. |

The fallback engages only while `toolCallsStarted === 0`. Once a tool has fired
the run refuses to fall back and exits instead, so a payment can never execute
twice. Falling back writes a line to **stderr** — the only way to tell a
scripted run from a live one.

#### `AGENT_SESSION_KEY`

Not a behaviour switch, but the one credential whose *wrong* value fails in a
way that looks like a bug rather than a config error.

| Value | Behaviour |
|---|---|
| the key matching the wallet's on-chain `agentSigner` | Payments authorize. |
| any other valid key | Every payment fails `InvalidAgentSignature`. |
| missing or malformed | `payMerchant` returns `invalid_request`; nothing is sent. |

---

## Feature availability

#### `FAUCET_ENABLED`

| Value | Behaviour |
|---|---|
| `1` *(default)* | `POST /api/faucet` mints 100 MUSDC, 60s cooldown per address. |
| `0` | Route returns 403. Unfunded burners cannot pay at all. |

#### `POLICY_ADMIN_ENABLED`

| Value | Behaviour |
|---|---|
| `1` *(default)* | The dashboard's **Revoke** button works — the relayer (the PBM wallet's owner) sends `revoke()`, zeroing the agent's policy. 30s cooldown regardless. |
| `0` | Route returns 403; the button errors. |

Worth setting to `0` on a public host: an open revoke lets any visitor zero the
agent's policy and break the agent demo, and only the `ADMIN_TOKEN` can re-arm it
(`POST /api/admin/policy/arm`, which `demo:reset` calls). That is a denial risk,
not a spending one.

#### `INTENT_TTL_SECONDS`

| Value | Behaviour |
|---|---|
| `600` *(default)* | How long a quote stays payable, measured from block timestamp. The signed authorization window is this + 120s. |
| ≥ 60 | As given. |

A payer who leaves the review card open past this gets an expiry error and a
"get new quote" path rather than a failed transaction.

---

## Resulting flows

| Flow | Condition | Characteristics |
|---|---|---|
| Burner, fixed key | `NEXT_PUBLIC_BURNER` holds a key | deterministic account, no faucet round-trip if pre-funded |
| Burner, per-device | `?burner=1`, no env key | localStorage key, faucet-funded on demand |
| Connected wallet | burner off | real wallet, chain-switch prompt, no faucet |
| x402 `exact` | vanilla client against the 402 route | on-chain payer is the relayer — one custodial hop |
| `gantry-pbm` | agent CLI or `e2e:pbm` | on-chain payer is the PBM wallet; policy enforced by contract revert |
| Live narration | LLM key set | model decides and narrates; timeout falls back |
| Scripted narration | key unset, or fallback fired | identical wire traffic; announced on stderr |

---

## Sharp edges

1. `NEXT_PUBLIC_*` values are read at build time — restart after editing.
2. A configured `NEXT_PUBLIC_BURNER` key cannot be turned off per request — there is no `?burner=0`.
3. The printed QR carries no query string, so a scanning phone gets the burner only when `NEXT_PUBLIC_BURNER` holds a key.
4. `FAUCET_ENABLED=0` breaks the burner flow for any unfunded wallet.
5. `ORDER_TOKEN` must match what the PBM wallet holds.
6. `AGENT_SESSION_KEY` must match the wallet's on-chain `agentSigner`.
7. `NEXT_PUBLIC_APP_URL` is encoded into the printed QR
   (`app/qr/[handle]/page.tsx:10`) — a standee printed against `localhost` is
   unusable from a phone.
8. Cooldowns differ in scope: faucet per **address**, merchant registration per
   **IP**, revoke per **instance**.
