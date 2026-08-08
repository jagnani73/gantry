# Configuration reference

The environment variables that change **what the app does** — which key signs a
payment, which token moves, whether the agent thinks for itself.

Plumbing is deliberately not here: chain selection, RPC and WebSocket URLs,
ports, database path, CORS, and the keys themselves are documented inline in the
three `.env.example` files. Nothing below is needed to *run* the app — only to
change how it behaves.

Claims are traced from the code. References name a **file and a symbol** rather
than a line number: the line numbers this file used to carry were all stale
within one working session, which made them worse than no reference at all.

---

## Which key signs a human payment

The payer page has two key sources behind one signing path.

#### `NEXT_PUBLIC_BURNER`

One value decides everything about the payer's key. There is no URL override, so
env and URL can never disagree about which account signs.

| Value | Signing key |
|---|---|
| unset or `0` *(default)* | Connected wallet. |
| `1` | Burner, using a per-device key persisted in `localStorage` under `gantry.burner.key` and funded on demand by the faucet. |
| `0x` + 64 hex | Burner, pinned to that account on every device and session. Fund it once ahead of time. |
| anything else | Connected wallet, plus a one-time `console.warn` naming the bad value — a typo must never silently change the payer. |

Read once at first render (`pay-client.tsx`, `useState(burnerEnvEnabled)`), so
there is no flicker between modes and nothing to read from the URL. The values
are resolved by `burnerConfig()` in `web/src/lib/env.ts`.

### Funding and cap

Burner only (`pay-client.tsx`, the `readBalance` poll inside the `burner`
branch). The connected wallet is never funded and must already hold the token.

| Balance vs `amountIn` | Result |
|---|---|
| sufficient | Straight to signing, no faucet call. |
| insufficient | `funding` step → the funder **transfers 4 real USDC** (60s cooldown per address) → poll balance 10× 1.5s → sign, or fail "faucet funds not visible yet" after ~15s. |

The funder is the relayer wallet: settlement is in real Circle USDC, which
cannot be minted, so the grant is a transfer out of a finite balance and can run
out (`FunderExhausted`).

Because that balance sits on the only gas key and the cooldown is per-*address*,
funding is gated on **`NODE_ENV`** — the standard Node signal rather than a
Gantry flag, since the question is "is this a demo host", not "who is asking".

`NODE_ENV` gates **two** unauthenticated affordances that spend the relayer's
balances — funding payers, and registering merchants:

| `NODE_ENV` | Payer faucet | Self-service onboarding |
|---|---|---|
| unset / anything else (`pnpm dev`) | On — the relayer transfers 4 USDC per grant | On — `POST /api/merchants` registers, `/onboard` renders the form |
| `production` (set by the backend Dockerfile, and by Vercel for the web build) | **Capped at 20 USDC per rolling 24h across ALL addresses** — then `FaucetBudgetExhausted` (429) | Off — `OnboardingDisabled` (403); `/onboard` renders a verified-merchant-only card instead |

Onboarding spends relayer ETH per call and permanently claims a handle, and its
cooldown is per-**IP**, which bounds one browser rather than one attacker.
Because `GantryCore` stores a single `onlyRelayer` address, the deployed backend
and the demo laptop are necessarily the same key — so draining it publicly stops
every door, not just onboarding.

The two are gated differently on purpose. Onboarding is switched **off**: it
spends ETH — the gas key every door depends on — and permanently claims a
handle, and nobody needs to onboard from their seat. Funding is **capped**
instead, because burner mode is what lets a judge scan the deck's QR and pay
with no wallet at all; switching it off would make the deployed payer page
unusable by the people it exists to convince. 20 USDC is five grants — enough
for a Q&A, and a loss the ETH→USDC top-up swap absorbs without touching gas.

The cap is in-process, so a restart resets it and two instances get one cap
each. That bounds casual abuse, which is the real threat to a faucet whose asset
has no market value; it is not a security boundary.

The boot log states which mode the process is in, and every refusal names the
fix — the one way this bites is a rehearsal started with `NODE_ENV=production`.

Amount cap: **S$5** on the burner, S$9999 on a connected wallet (`pay-client.tsx`,
the `max` prop on `AmountPad`). The burner cap follows from the 4 USDC grant — it
keeps one grant sufficient for the payment it was requested for.

---

## Whether the agent thinks for itself

#### `GOOGLE_GENERATIVE_AI_API_KEY`

| Value | Behaviour |
|---|---|
| unset | Scripted narration immediately, no LLM call (`agent/src/index.ts`, the `!env.googleApiKey` guard in `main()`). |
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

#### `POLICY_ADMIN_ENABLED`

| Value | Behaviour |
|---|---|
| `1` *(default)* | The dashboard's **Revoke** button works — the relayer (the PBM wallet's owner) sends `revoke()`, zeroing the agent's policy. 30s cooldown regardless. |
| `0` | Route returns 403; the button errors. |

Worth setting to `0` on a public host: an open revoke lets any visitor zero the
agent's policy and break the agent demo, and only the `ADMIN_TOKEN` can re-arm it
(`POST /api/admin/policy/arm`, which `demo:reset` calls). That is a denial risk,
not a spending one.

---

## Resulting flows

| Flow | Condition | Characteristics |
|---|---|---|
| Burner, fixed key | `NEXT_PUBLIC_BURNER` holds a key | deterministic account, no faucet round-trip if pre-funded |
| Burner, per-device | `NEXT_PUBLIC_BURNER=1` | localStorage key, faucet-funded on demand |
| Connected wallet | burner off | real wallet, chain-switch prompt, no faucet |
| x402 `exact` | vanilla client against the 402 route | on-chain payer is the relayer — one custodial hop |
| `gantry-pbm` | agent CLI or `e2e:pbm` | on-chain payer is the PBM wallet; policy enforced by contract revert |
| Live narration | LLM key set | model decides and narrates; timeout falls back |
| Scripted narration | key unset, or fallback fired | identical wire traffic; announced on stderr |

---

## Sharp edges

1. `NEXT_PUBLIC_*` values are read at build time — restart after editing.
2. Switching payer modes needs an env edit and a restart — there is no per-request override.
3. `AGENT_SESSION_KEY` must match the wallet's on-chain `agentSigner`.
4. `NEXT_PUBLIC_APP_URL` is encoded into the printed QR
   (`app/qr/[handle]/page.tsx`, `payUrl`) — a standee printed against
   `localhost` is unusable from a phone.
5. Cooldowns differ in scope: faucet per **address**, merchant registration per
   **IP**, revoke per **instance**. The merchant-registration one is in-process
   and survives `pnpm demo:reset` — restart the backend between back-to-back
   onboarding takes or the second will 429.
