# Configuration reference

The environment variables that change **what the app does** — which key signs a
payment, which key owns an agent, whether the agent thinks for itself, and
whether this host hands out money to strangers.

Plumbing is deliberately not here: RPC and WebSocket URLs, ports, CORS and
the keys themselves are documented inline in the four `.env.example` files.
(Chain selection and the database path are no longer configurable at all — they
are hardcoded in `config.ts`.) Nothing below is needed to *run* the app — only to
change how it behaves.

Claims are traced from the code. References name a **file and a symbol** rather
than a line number: the line numbers this file used to carry were all stale
within one working session, which made them worse than no reference at all.

---

## Which key signs a payment

The payer page has two key sources behind one signing path.

#### `NEXT_PUBLIC_DEMO_KEY`

One value decides everything about the payer's key. There is no URL override, so
env and URL can never disagree about which account signs.

| Value | Signing key |
|---|---|
| unset or `0` *(default)* | Connected wallet. |
| `0x` + 64 hex | The pinned demo account, on every device and session. |
| anything else | Connected wallet, plus a one-time `console.warn` naming the bad value — a typo must never silently change the payer. |

Resolved by `demoKey()` / `demoAccountEnabled()` in `web/src/lib/env.ts`;
`getDemoAccount()` in `web/src/lib/demo-account.ts` builds the account and
**throws rather than falling back**, because silently signing with some other key
is the one outcome that must never happen.

**There is no per-device burner any more.** It existed when the demo account was
a throwaway: generate a key into `localStorage`, fund it, pay, forget it. That
stopped working the moment agents became payer-owned on-chain — a fresh random
address owns no agent wallets and has no payment history, so the wallet, activity
and agents screens would all render permanently empty for it. One pinned account
also means the phone that scans the printed standee and the laptop showing the
payer app are the *same* payer, so a payment made on one appears on the other.

The price of that decision, and it belongs on the honest-labels list: on a
deployed build the demo key is **shared**. `NEXT_PUBLIC_*` is inlined into the
client bundle, so anyone can read it in devtools, and every visitor signs as the
same payer — the payment history on that build is not private. Testnet demo
funds only; never the relayer's key.

### Funding and cap

Demo account only (`components/payer/pay-flow.tsx`, the balance check before
signing). A connected wallet is never funded and must already hold the token.

| Balance vs `amountIn` | Result |
|---|---|
| sufficient | Straight to signing, no faucet call. |
| insufficient | `funding` step → the funder **transfers 4 real USDC** (60s cooldown per address) → poll the balance 10 × 1.5s, because RPC replicas lag behind the mined transfer → sign, or fail "funds not visible yet — try again". |

The funder is the relayer wallet: settlement is in real Circle USDC, which
cannot be minted, so the grant is a transfer out of a finite balance and can run
out (`FunderExhausted`).

`POST /api/faucet` has a **second leg**: a small ETH top-up (target 0.002 ETH,
sent only when the address is below it). Agent PBM wallets are owned by the
payer, so `createWallet`, `setPolicy` and `revoke` are the payer's own
transactions and a key that has never held ETH cannot send them. This does not
weaken the payment story — paying a merchant is still an EIP-3009 signature the
relayer submits, and costs the payer nothing. The ETH leg **never throws**: by
the time it runs the USDC grant has landed, and a payer who cannot configure an
agent has one screen they cannot use, while a payer who cannot be funded cannot
pay at all. It is also deliberately **not on the wire** — `FaucetResponse`
reports the USDC grant only, so no screen can grow a gas-balance readout.

Amount cap: **S$5** on the demo account, S$9999 on a connected wallet
(`pay-flow.tsx`, `BURNER_MAX_SGD` / `WALLET_MAX_SGD`). The demo cap follows from
the 4 USDC grant — it keeps one grant sufficient for the payment it was
requested for.

---

## Whether this host hands out money to strangers

#### `NODE_ENV`

Not a Gantry setting — the standard Node signal, read once in `config.ts` and
turned into a named `HostClass` (`demo` | `public`), because the question is "is
this a demo host", not "who is asking". Three unauthenticated affordances key off
that one classification, and each spends the relayer's balances:

| `NODE_ENV` | Payer faucet | Self-service onboarding | Profile editing |
|---|---|---|---|
| unset / anything else (`pnpm dev`) | On, unmetered — 4 USDC + up to 0.002 ETH per grant | On — `POST /api/merchants` registers, `/onboard` renders the form | On — `PATCH /api/merchants/:handle` accepts anyone |
| `production` | **Capped at 20 USDC and 0.01 ETH per rolling 24h across ALL addresses**, then `FaucetBudgetExhausted` (429) | Off — `OnboardingDisabled` (403); `/onboard` renders a verified-merchant-only card instead | Off — `ProfileEditingDisabled` (403), unless the caller sends a valid `x-admin-token` |

`classifyHost` fails **open** by design (anything that is not exactly
`production` counts as a demo host), so it warns loudly on any value it does not
recognise: a silent `Production` typo or a trailing space would leave a real-USDC
spigot and open merchant registration on a public box.

The three are gated differently because the stakes differ.

- **Onboarding is switched off.** It spends relayer ETH — the gas key every door
  depends on — and permanently claims a handle, and nobody needs to onboard from
  their seat. Its cooldown is per-**IP**, which bounds one browser rather than one
  attacker.
- **Profile editing is switched off** for a blunter reason: the route is
  unauthenticated, so on a public host anyone with the URL could rewrite any
  shop's identity. There is no merchant login in Gantry and we are not inventing
  one; the operator escape hatch is `x-admin-token`, which `demo-reset` uses to
  seed the canonical shops.
- **Funding is capped, not off**, because the demo account is what lets a judge
  scan the deck's QR and pay with no wallet at all; switching it off would make
  the deployed payer page unusable by the people it exists to convince. 20 USDC
  is five grants — enough for a Q&A, and a loss the ETH→USDC top-up swap can
  replace, though not for free: that swap buys USDC with ETH from the same key,
  bounded by a per-swap cap. The ETH leg carries its **own** ceiling rather than
  sharing a counter, so a run of gas top-ups can never close the door on payments
  or the reverse.

The caps are in-process, so a restart resets them and two instances get one cap
each. That bounds casual abuse, which is the real threat to a faucet whose asset
has no market value; it is not a security boundary.

The boot log states which mode the process is in, and every refusal names the
fix — the one way this bites is a rehearsal started with `NODE_ENV=production`.

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
way that looks like a bug rather than a config error. The CLI carries **no
wallet address**: it derives the signer from this key and asks
`GET /api/agents?agentSigner=…` which wallets it may act for
(`resolveAgentWallet` in `agent/src/pay-flow.ts`), preferring one whose policy is
actually `active` — picking a lapsed wallet because it happened to be first reads
on stage as "the agent is broken" rather than "that policy is over".

| Value | Behaviour |
|---|---|
| the signer of an existing PBM wallet | Payments authorize. |
| a valid key no wallet names as its `agentSigner` | `no_agent_wallet` — nothing is created, nothing is sent. |
| the signer of a wallet whose policy lapsed or was revoked | Every payment reverts `PolicyExpired`. |
| missing or malformed | `payMerchant` returns `invalid_request`; nothing is sent. |

Create the wallet from the payer app's agents screen with this key's address as
the signer, or rotate an existing wallet's signer on-chain with
`setAgentSigner`.

---

## Agent ownership — what is no longer configurable

`AgentPBMWallet.setPolicy` and `revoke` are `onlyOwner`, and the owner is the
**payer**. So there is no server-side policy write path and nothing to gate:
`POST /api/policy`, `POST /api/policy/revoke`, `GET /api/policy` and the
`POLICY_ADMIN_ENABLED` flag were all deleted rather than hardened. Revoke is a
button in the payer app that sends the payer's own transaction
(`components/payer/agent-writes.ts`), which is why the faucet now grants gas.

Reads stay open and unauthenticated on purpose: `GET /api/agents` (filtered by
`owner` and/or `agentSigner` — at least one is required) and
`GET /api/agents/:wallet` read public chain state, and a wallet's protection is
that only its owner can write to it.

---

## Resulting flows

| Flow | Condition | Characteristics |
|---|---|---|
| Demo account | `NEXT_PUBLIC_DEMO_KEY` holds a key | one pinned account shared by every visitor, faucet-funded on demand, S$5 cap |
| Connected wallet | demo key unset or `0` | real wallet, chain-switch prompt, no faucet, S$9999 cap |
| x402 `exact` | vanilla client against the 402 route | on-chain payer is the relayer — one custodial hop |
| `gantry-pbm` | agent CLI or `pnpm --filter @gantry/agent e2e:pbm` | on-chain payer is the PBM wallet; policy enforced by contract revert |
| Live narration | LLM key set | model decides and narrates; timeout falls back |
| Scripted narration | key unset, or fallback fired | identical wire traffic; announced on stderr |

---

## Sharp edges

1. `NEXT_PUBLIC_*` values are read at build time — restart after editing, and on
   Vercel set them *before* the first build.
2. Switching payer modes needs an env edit and a restart — there is no
   per-request override.
3. `AGENT_SESSION_KEY` must be the `agentSigner` of a wallet that already exists;
   creating one is a payer action, not a config change.
4. `NEXT_PUBLIC_APP_URL` is encoded into the printed QR
   (`app/qr/[handle]/page.tsx`) — a standee printed against `localhost` is
   unusable from a phone.
5. Cooldowns differ in scope: faucet per **address** (60s), merchant registration
   per **IP** (30s), profile edit per **IP** (10s). All are in-process and
   survive `pnpm demo:reset` — space back-to-back onboarding takes or restart the
   backend, or the second will 429.
6. The payer needs **gas** only to own an agent. If the ETH leg of the faucet was
   refused (its own 24h ceiling, or the relayer near its 0.05 ETH reserve), the
   payer can still pay merchants and simply cannot configure an agent. The
   refusal is a server-side warning, not a client error — check the backend log.
