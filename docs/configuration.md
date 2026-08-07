# Configuration reference

Gantry has no single mode switch. Behaviour is the product of independent
environment variables, several of which interact in non-obvious ways. This file
documents what each one does, what happens when it is unset, and which flow the
result produces.

Every claim is traced from the code, with `file:line` references so it can be
re-checked as the code moves.

| File | Read by |
|---|---|
| `packages/backend/.env` | backend |
| `packages/web/.env.local` | web |
| `packages/agent/.env` | agent CLI |

---

## Payer key source (human door)

The payer page has two key sources behind one signing path. Which one is used is
decided at `packages/web/src/components/pay-client.tsx:63`:

```ts
setBurner(burnerEnvEnabled() || query.get("burner") === "1");
```

Because it is an **OR**, the query parameter can only turn the burner *on*:

| `NEXT_PUBLIC_BURNER` | URL | Key source |
|---|---|---|
| `0` or unset | `/pay/<handle>` | connected wallet |
| `0` or unset | `/pay/<handle>?burner=1` | burner |
| `1` | any | burner |

There is no `?burner=0`. Disabling the burner entirely requires setting
`NEXT_PUBLIC_BURNER=0` (or removing it).

### Which burner key

`packages/web/src/lib/burner.ts`

- **`NEXT_PUBLIC_BURNER_KEY` set** — a valid `0x` + 64 hex string is used
  directly. The same account on every device and every session, so it can be
  funded once ahead of time.
- **unset** — a key is generated and persisted in `localStorage` under
  `gantry.burner.key`. One wallet per browser; clearing site data generates a
  new one.

A malformed value (wrong length, non-hex) is **silently ignored** and treated as
unset, falling through to the localStorage path rather than raising an error.

### Funding

`pay-client.tsx:145-165`, burner path only:

1. Read the payer's balance of `intent.tokenIn`.
2. If it already covers `amountIn`, go straight to signing — no faucet call.
3. Otherwise enter the `funding` step and call `POST /api/faucet`, which mints
   **100 MUSDC**.
4. Poll the balance every 1.5s up to 10 times. If the mint is still not visible
   after ~15s, fail with "faucet funds not visible yet" — RPC replicas lag
   behind the mint.

The faucet enforces a **60s cooldown per address** (`services/faucet.ts:9`) and
is gated by `FAUCET_ENABLED`. With the faucet disabled, an unfunded burner
cannot pay at all: the flow stops at step 3 with `FaucetDisabled`.

The connected-wallet path never funds anything — the wallet must already hold
the token — and prompts a chain switch to Base Sepolia if needed.

### Amount cap

`pay-client.tsx:242` — the burner is capped at **S$130**, the connected wallet at
S$9999. The cap follows from the faucet minting 100 MUSDC per call.

---

## Token selection

Three variables, three different paths.

| Variable | Side | Governs |
|---|---|---|
| `DEFAULT_TOKEN` | backend | fallback for `POST /api/intents` when the request omits `token` (`services/intents.ts:62`) |
| `ORDER_TOKEN` | backend | agent door — the x402 402 offer asset, `POST /api/pbm/intent`, and the policy panel's display token |
| `NEXT_PUBLIC_PAY_TOKEN` | web | connected-wallet path only |

Two consequences that are not obvious from the names:

- **The burner ignores `NEXT_PUBLIC_PAY_TOKEN`.** `pay-client.tsx:115` sends
  `token: burner ? "MUSDC" : walletPayToken()`, because the faucet can only mint
  MUSDC.
- **`DEFAULT_TOKEN` rarely applies.** Both the payer page and `e2e:pay` send an
  explicit `token`, so it is a fallback rather than the usual path.

`ORDER_TOKEN` defaults to real USDC when the chain has it, otherwise MUSDC. The
agent's PBM wallet is MUSDC-funded and the faucet cannot mint real USDC, so
those two must agree; `demo:reset` warns when they diverge.

---

## Agent narration

`packages/agent/src/index.ts`

| `GOOGLE_GENERATIVE_AI_API_KEY` | Behaviour |
|---|---|
| unset | scripted immediately, no LLM call (`index.ts:126`) |
| set | live model, with a scripted fallback if nothing streams in time |

Both modes execute **identical wire traffic** — the same tool functions, HTTP
requests and on-chain settlement. Only the narration differs.

The fallback is gated on `toolCallsStarted === 0`. Once a tool has fired the run
refuses to fall back and exits instead, so a payment can never execute twice.
Engaging the fallback writes a line to **stderr**, which is the only way to
distinguish a scripted run from a live one.

| Variable | Default | Notes |
|---|---|---|
| `AGENT_LLM_TIMEOUT_MS` | `8000` | time with no *real* stream part before falling back; synthetic `start` parts are ignored |
| `AGENT_LLM_MODEL` | `gemini-flash-latest` | |
| `AGENT_SESSION_KEY` | — | must be the key whose address is the wallet's on-chain `agentSigner`, or every payment fails `InvalidAgentSignature` |
| `PBM_WALLET_ADDRESS` | pinned demo wallet | override only for a local chain or fresh deploy |

---

## Feature gates

Each gates a path that spends relayer gas or exposes control.

| Variable | Default | Disabled behaviour |
|---|---|---|
| `FAUCET_ENABLED` | `1` | `POST /api/faucet` → 403; unfunded burners cannot pay |
| `ONBOARDING_ENABLED` | `0` | `POST /api/merchants` → 403; `/onboard` reads the flag from `/health` and renders an explanatory card |
| `POLICY_ADMIN_ENABLED` | `1` | `POST /api/policy/revoke` → 403 |

`ONBOARDING_ENABLED` defaults off because it spends relayer ETH on an
unauthenticated request while `CORS_ORIGIN` is `*` by default.

Rate limits apply even when enabled. Onboarding carries a **30s per-IP cooldown**
recorded only after a successful registration, plus a per-IP in-flight guard.
Revoke carries a **30s cooldown** unconditionally. The onboarding cooldown is
in-process and survives `demo:reset`.

---

## RPC and networking

- **`BASE_SEPOLIA_RPC_URL`** — comma-separated, tried in order. A single URL is
  a valid one-entry list. `https://sepolia.base.org` is always appended as last
  resort. The first entry is the primary.
- **`BASE_SEPOLIA_WS_URL`** — the indexer's live path. Defaults to the *first*
  RPC URL with `https://` replaced by `wss://`. This client has no fallback; if
  it drops, the 15s `getLogs` sweep still carries correctness and only latency
  degrades.
- **`CORS_ORIGIN`** — `*` by default.
- **`ANVIL_RPC_URL`** — used only when `CHAIN_ID=31337`.

viem's transport ranking is deliberately not enabled: it would reorder providers
from background latency samples, which can route a request to the rate-limited
public node while a paid provider is healthy. Ordered failover moves only on a
real error.

`packages/contracts/.env` also defines `BASE_SEPOLIA_RPC_URL`, and that one must
stay a **single URL** — foundry cannot parse the comma-separated form.

---

## URLs

- **`NEXT_PUBLIC_APP_URL`** is encoded into the printed QR:
  `app/qr/[handle]/page.tsx:10` builds `${appUrl()}/pay/${handle}`. A QR
  generated against one host is useless from another.
- **`NEXT_PUBLIC_BACKEND_URL`** — every browser-originated call. A wrong value
  surfaces as "disconnected — check backend URL" on the dashboard rather than
  hanging silently.

---

## Behaviour matrix

| Flow | Condition | Characteristics |
|---|---|---|
| Burner, fixed key | `NEXT_PUBLIC_BURNER=1` + valid `NEXT_PUBLIC_BURNER_KEY` | deterministic account, no faucet round-trip if pre-funded, MUSDC, S$130 cap |
| Burner, per-device | burner on, no valid env key | localStorage key, faucet-funded on demand, MUSDC, S$130 cap |
| Connected wallet | burner off | real wallet, chain-switch prompt, `NEXT_PUBLIC_PAY_TOKEN`, no faucet, S$9999 cap |
| x402 `exact` | vanilla client against the 402 route | on-chain payer is the relayer — one custodial hop |
| `gantry-pbm` | agent CLI or `e2e:pbm` | on-chain payer is the PBM wallet; policy enforced by contract revert |
| Live narration | LLM key set | model decides and narrates; timeout falls back |
| Scripted narration | key unset, or fallback fired | identical wire traffic; announced on stderr |
| Onboarding enabled | `ONBOARDING_ENABLED=1` | relayer-paid registration, 30s per-IP cooldown |
| Onboarding disabled | default | route 403s; the form explains itself |

---

## Sharp edges

1. Web variables are read at build time — restart after editing.
2. `NEXT_PUBLIC_BURNER=1` cannot be overridden off per request.
3. A malformed `NEXT_PUBLIC_BURNER_KEY` degrades silently to a localStorage key.
4. `FAUCET_ENABLED=0` breaks the burner flow for any unfunded wallet.
5. The faucet cooldown is per **address**; onboarding and revoke cooldowns are
   per **IP** and per **instance** respectively.
6. The onboarding cooldown survives `demo:reset`.
7. `ORDER_TOKEN` must match what the PBM wallet actually holds.
8. `AGENT_SESSION_KEY` must match the wallet's on-chain `agentSigner`.
9. `packages/contracts/.env` shares the `BASE_SEPOLIA_RPC_URL` name but not its
   comma-separated format.
