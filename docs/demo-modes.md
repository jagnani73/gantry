# Demo modes — every env knob, what it changes, and why

Gantry has no `DEMO_MODE` switch. Behaviour comes from a handful of independent
env vars, and the useful "modes" are just presets over them. This file is the
map: what each knob does, what happens when it is unset, and which flow you get.

Everything here is traced from the code, with file references so it can be
re-checked when the code moves.

**Three env files**, all read at process start:

| File | Read by | Notes |
|---|---|---|
| `packages/backend/.env` | backend | secrets live here |
| `packages/web/.env.local` | web | `NEXT_PUBLIC_*` are **inlined at build time** |
| `packages/agent/.env` | agent CLI | session key + optional LLM key |

`NEXT_PUBLIC_*` values are baked into the bundle by Next, so changing one needs
a dev-server restart (or a rebuild in production) — editing `.env.local` while
`pnpm dev` is running will not take effect on its own.

---

## Presets

Start from one of these, then read the per-knob detail below.

### A. On-stage laptop (the finals demo)

```bash
# backend
ONBOARDING_ENABLED=1        # register a merchant live
POLICY_ADMIN_ENABLED=1      # the Revoke beat
FAUCET_ENABLED=1
ORDER_TOKEN=MUSDC
# web
NEXT_PUBLIC_APP_URL=http://<laptop-LAN-IP>:3000
NEXT_PUBLIC_BACKEND_URL=http://<laptop-LAN-IP>:4000
NEXT_PUBLIC_BURNER=1
NEXT_PUBLIC_BURNER_KEY=0x<pre-funded key>
# agent
GOOGLE_GENERATIVE_AI_API_KEY=<AI Studio key>
```

Everything on, burner forced, deterministic pre-funded key so the phone never
waits on a faucet mint. The LAN IP matters twice: the phone must reach both
servers, and it is what gets encoded into the printed QR.

### B. Public deployment (the Devpost "live dashboard" link)

```bash
# backend
ONBOARDING_ENABLED=0        # (or just unset — this is the default)
POLICY_ADMIN_ENABLED=0
FAUCET_ENABLED=0
# web
NEXT_PUBLIC_APP_URL=https://<vercel-domain>
NEXT_PUBLIC_BACKEND_URL=https://<backend-host>
NEXT_PUBLIC_BURNER=0
# NEXT_PUBLIC_BURNER_KEY unset
```

Every relayer-gas-spending path is off. `/onboard` reads `onboardingEnabled`
from `/health` and renders an explanatory card instead of a dead form.

### C. Local development

```bash
# backend
ONBOARDING_ENABLED=1
ORDER_TOKEN=MUSDC
# web
NEXT_PUBLIC_BURNER=0        # opt in per-visit with ?burner=1
# NEXT_PUBLIC_BURNER_KEY unset — per-device key + faucet
```

---

## The human door: burner vs wallet-connect

This is the flow with the most branching, and the one the question usually
lands on.

### How the mode is chosen

`packages/web/src/components/pay-client.tsx:63`

```ts
setBurner(burnerEnvEnabled() || query.get("burner") === "1");
```

It is an **OR**, which has one consequence worth knowing:

| `NEXT_PUBLIC_BURNER` | URL | Result |
|---|---|---|
| `0` / unset | `/pay/x` | wallet-connect |
| `0` / unset | `/pay/x?burner=1` | burner |
| `1` | `/pay/x` | burner |
| `1` | `/pay/x?burner=1` | burner |

**There is no way to force burner OFF while `NEXT_PUBLIC_BURNER=1`.** No
`?burner=0` is handled. To disable it entirely you must set
`NEXT_PUBLIC_BURNER=0` (or remove it) and restart. On stage that is the safer
default anyway — you want the flag on precisely when you want it on.

### Which key the burner uses

`packages/web/src/lib/burner.ts`

- **`NEXT_PUBLIC_BURNER_KEY` set** (valid `0x` + 64 hex) → that account, every
  device, every session. Deterministic: pre-fund it once and the stage phone
  never touches the faucet.
- **unset** → a key is generated and persisted in `localStorage` under
  `gantry.burner.key`, per browser. Different phone, different wallet; clearing
  site data mints a new one.

An invalid key (wrong length, not hex) is silently ignored and treated as unset —
so a typo in `NEXT_PUBLIC_BURNER_KEY` degrades to the localStorage path rather
than erroring. Worth knowing if the stage wallet unexpectedly has no funds.

### Funding

`pay-client.tsx:145-165`. Only on the burner path:

1. read the payer's balance of `intent.tokenIn`
2. if it covers `amountIn` → straight to signing, no faucet call
3. otherwise → `funding` step → `POST /api/faucet` → mints **100 MUSDC**
4. poll the balance every 1.5s, up to 10 times; if still not visible after ~15s,
   fail with "faucet funds not visible yet" (RPC replicas lag behind the mint)

The faucet has a **60s cooldown per address** (`services/faucet.ts:9`) and is
gated by `FAUCET_ENABLED`. With `FAUCET_ENABLED=0` an unfunded burner cannot pay
at all — the flow dies at step 3 with `FaucetDisabled`.

The wallet-connect path never funds anything; the connected wallet must already
hold the token, and the app will prompt a chain switch to Base Sepolia.

### Amount cap

`pay-client.tsx:242` — burner is capped at **S$130**, wallet-connect at S$9999.
The cap exists because the faucet mints 100 MUSDC at a time.

---

## The three token knobs

These are easy to confuse. They govern different doors.

| Var | Where | Governs |
|---|---|---|
| `DEFAULT_TOKEN` | backend | fallback for `POST /api/intents` when the request omits `token` (`services/intents.ts:62`) |
| `ORDER_TOKEN` | backend | the **agent door**: the x402 402 offer asset, `POST /api/pbm/intent`, and the policy panel's display token |
| `NEXT_PUBLIC_PAY_TOKEN` | web | **wallet-connect path only** |

Two things that surprise people:

- **The burner ignores `NEXT_PUBLIC_PAY_TOKEN` entirely.** `pay-client.tsx:115`
  sends `token: burner ? "MUSDC" : walletPayToken()` — the burner is always
  MUSDC, because the faucet can only mint MUSDC.
- **`DEFAULT_TOKEN` rarely fires**, because both the payer page and `e2e:pay`
  send an explicit `token`. It is the fallback, not the usual path.

`ORDER_TOKEN` defaults to real USDC when the chain has it, else MUSDC. **Keep it
`MUSDC` for the demo** — the agent's PBM wallet is MUSDC-funded and the faucet
cannot mint real USDC. `demo:reset` warns if it diverges.

---

## The agent: live LLM vs scripted

`packages/agent/src/index.ts`

| `GOOGLE_GENERATIVE_AI_API_KEY` | Behaviour |
|---|---|
| unset | scripted immediately — no LLM call at all (`index.ts:126`) |
| set | live Gemini; falls back to scripted if nothing streams within the timeout |

Both modes run **identical wire traffic** — the same tool functions, the same
HTTP, the same on-chain settlement. Only the narration differs. That is why the
honest-labels list can call the payment real in either mode.

The fallback is hard-gated on `toolCallsStarted === 0`. If a tool has already
fired, the run **refuses** to fall back and exits — a payment must never run
twice. Falling back also prints a line to **stderr**, so an operator can tell a
scripted run from a live one; without that, a quota 429 would look identical to
a genuine live run.

- `AGENT_LLM_TIMEOUT_MS` — default 8000. Time with no *real* stream part before
  falling back. Synthetic `start` parts are ignored, or the timer would defuse
  itself ~5ms in.
- `AGENT_LLM_MODEL` — default `gemini-flash-latest`.
- `AGENT_SESSION_KEY` — **must** be the key whose address is the wallet's
  on-chain `agentSigner`. A fresh key fails every payment with
  `InvalidAgentSignature`.
- `PBM_WALLET_ADDRESS` — leave unset; defaults to the pinned demo wallet.

---

## Kill switches

All three gate paths that spend the relayer's gas or expose control.

| Var | Default | Off means |
|---|---|---|
| `FAUCET_ENABLED` | `1` | `POST /api/faucet` → 403; unfunded burners cannot pay |
| `ONBOARDING_ENABLED` | **`0`** | `POST /api/merchants` → 403; `/onboard` shows an explanatory card |
| `POLICY_ADMIN_ENABLED` | `1` | `POST /api/policy/revoke` → 403; the Revoke beat is unavailable |

`ONBOARDING_ENABLED` defaults **off** deliberately: it spends relayer ETH on an
unauthenticated request and `CORS_ORIGIN` is `*` by default, so the safe default
is the public-host one and the demo laptop opts in.

Rate limits apply even when enabled: onboarding has a **30s per-IP cooldown**
recorded only after a successful registration, plus a per-IP in-flight guard;
revoke has a **30s cooldown** regardless. The onboarding cooldown is in-process
and **survives `demo:reset`** — back-to-back registration takes inside 30s will
429, which matters when reshooting the clip.

---

## RPC and networking

- **`BASE_SEPOLIA_RPC_URL`** — comma-separated, tried in order. One URL is a
  valid single-entry list. `https://sepolia.base.org` is always appended as last
  resort. The first entry is the primary.
- **`BASE_SEPOLIA_WS_URL`** — the indexer's live path. Defaults to the *first*
  RPC URL with `https://` swapped for `wss://` (works for Alchemy). The WS
  client has no fallback; if it drops, the 15s `getLogs` sweep still carries
  correctness, only latency degrades.
- **`CORS_ORIGIN`** — `*` by default. Tighten on a public host.
- Ranking is deliberately off: viem could otherwise migrate to a lower-latency
  provider from background samples, landing a payment on the rate-limited public
  node while the paid provider is healthy.

`packages/contracts/.env` also has a `BASE_SEPOLIA_RPC_URL`, and **it must stay
a single URL** — foundry cannot parse the comma-separated form.

---

## URLs

- **`NEXT_PUBLIC_APP_URL`** is encoded into the printed QR
  (`app/qr/[handle]/page.tsx:10` builds `${appUrl()}/pay/${handle}`). A standee
  printed against `localhost` is useless to a phone. Set the LAN IP before
  printing, and the public domain before shooting the clip.
- **`NEXT_PUBLIC_BACKEND_URL`** — everything the browser calls. A wrong value
  surfaces as "disconnected — check backend URL" on the dashboard rather than a
  silent hang.

---

## Flow summary

| Flow | Trigger | Key facts |
|---|---|---|
| Human, burner, stage key | `NEXT_PUBLIC_BURNER=1` + `NEXT_PUBLIC_BURNER_KEY` | deterministic wallet, pre-funded, no faucet round-trip, MUSDC, S$130 cap |
| Human, burner, per-device | `?burner=1`, no env key | localStorage key, faucet-funded on demand (100 MUSDC, 60s/address), MUSDC, S$130 cap |
| Human, wallet-connect | burner off | real wallet, chain switch prompt, `NEXT_PUBLIC_PAY_TOKEN`, no faucet, S$9999 cap |
| Agent, vanilla x402 `exact` | `pnpm --filter @gantry/backend x402:buy` | unmodified `@x402/fetch`; on-chain payer is the relayer (one custodial hop) |
| Agent, `gantry-pbm` | agent CLI or `e2e:pbm` | non-custodial; on-chain payer is the PBM wallet; policy enforced by contract revert |
| Agent narration, live | `GOOGLE_GENERATIVE_AI_API_KEY` set | Gemini decides and narrates; 8s no-stream → scripted |
| Agent narration, scripted | key unset, or fallback fired | identical wire traffic; announced on stderr |
| Onboarding live | `ONBOARDING_ENABLED=1` | relayer-paid registration, 30s/IP cooldown |
| Onboarding disabled | default | `/onboard` explains itself via `/health` |

---

## Sharp edges

1. `NEXT_PUBLIC_*` are build-time. Restart the dev server after editing.
2. `NEXT_PUBLIC_BURNER=1` cannot be overridden off per-visit.
3. A malformed `NEXT_PUBLIC_BURNER_KEY` silently falls back to a localStorage
   key rather than failing loudly.
4. The onboarding cooldown survives `demo:reset`; restart the backend between
   takes.
5. `ORDER_TOKEN` must be `MUSDC` for the demo, whatever the chain supports.
6. `AGENT_SESSION_KEY` must match the wallet's on-chain `agentSigner`.
7. The contracts `.env` shares the `BASE_SEPOLIA_RPC_URL` name but not its
   comma-separated format.
