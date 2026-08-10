# Gantry

[![CI](https://github.com/jagnani73/gantry/actions/workflows/ci.yml/badge.svg)](https://github.com/jagnani73/gantry/actions/workflows/ci.yml)

**One rail, every payer: QR for humans, x402 for AI agents.**

Every payment system ever built assumes the payer is a human. Gantry is a payment rail on stablecoins where a merchant integrates once and gets paid by anyone — a person scanning a printed QR code, or an AI agent paying over the [x402 protocol](https://github.com/x402-foundation/x402). Both are encodings of the same on-chain `PaymentIntent`, both settle through the same contract, and the merchant always receives XSGD (Singapore-dollar stablecoin) — whatever token the payer sent.

Built for [NTU InnovateX Hackathon 2026](https://ntu-cctf-snz-innovatex-2026.devpost.com/) — Track 1: Payments & Financial Infrastructure.

## Live

| | |
|---|---|
| **Web** | **<https://gantry-innovatex.vercel.app>** — [merchant back-office](https://gantry-innovatex.vercel.app/merchant/ah-hock-chicken-rice/overview) · [payer app](https://gantry-innovatex.vercel.app/app) · [pay Ah Hock](https://gantry-innovatex.vercel.app/pay/ah-hock-chicken-rice) · [printable QR](https://gantry-innovatex.vercel.app/qr/ah-hock-chicken-rice) |
| **API** | <https://gantry-backend.onrender.com> — [`/health`](https://gantry-backend.onrender.com/health) reports the indexer's cursor, the chain head and the lag between them |

The backend is a Render free web service, so an idle instance spins down and the
first request after that waits ~50s. **The deployed pair is a shop window, not
the demo** — the stage run happens on a laptop, because self-service onboarding
and unauthenticated profile edits are switched off in production and payer
funding is capped rather than closed.

## The idea in three lines

1. A payment is an **intent**: "merchant M requests S$X."
2. A QR code and an HTTP `402 Payment Required` response are just **two encodings of the same intent**.
3. One settlement contract consumes both — atomically swapping whatever stablecoin arrived into XSGD — so a hawker and an API get paid the same way by tourists and by software.

## Why Singapore

- PayNow is excellent — for payers with a Singapore bank account. The ~16M international visitors who arrive each year have none; they fall back to cards (~2–3% merchant fees) or cash.
- AI agents can't open bank accounts at all. [x402](https://github.com/x402-foundation/x402) — launched May 2025, contributed to the Linux Foundation, whose x402 Foundation went operational in July 2026 — gives them a standard way to pay. Gantry gives them somewhere to spend.
- Agent spending runs inside on-chain allowances — daily caps, merchant-category allowlists, expiry — [MAS Project Orchid's Purpose-Bound Money](https://www.mas.gov.sg/schemes-and-initiatives/project-orchid) idea, applied to AI agents.

## Status

🚧 **In development** for Stage 1 submission (14 Aug 2026).

- [x] `GantryCore` — merchant registry + PaymentIntent + dual-door settlement ([verified on Base Sepolia](https://sepolia.basescan.org/address/0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0))
- [x] Human door — printed QR → mobile payer page → gasless EIP-3009 payment
- [x] Agent door — x402 v2 endpoint + self-hosted facilitator (`exact` via the bridge AND the non-custodial `gantry-pbm` scheme; unmodified `@x402/fetch` still pays end-to-end)
- [x] `AgentPBMWallet` — on-chain Purpose-Bound-Money spend policies for agents, minted per payer by a [permissionless factory](https://sepolia.basescan.org/address/0xd827C3445660a4D2d68c5D411DAbAE71B7fdcA05)
- [x] Stablecoin-in → XSGD-out atomic FX behind the `IGantrySwap` seam — shipping on `FixedRateSwap`, which accepts any token with an owner-listed rate (USDC today). A `GantrySwap` AMM was **deferred by decision (7 Aug 2026)**: a self-seeded toy pool is no closer to real FX than a fixed rate, and the interface is what makes the production path (real XSGD liquidity via aggregator/RFQ) a swap-in.
- [x] Merchant onboarding — one form, live handle availability, on-chain registration, printable QR (`/onboard`)
- [x] Merchant back-office — an overview with the live feed, transactions, payouts, QR/standee, profile and settings, with a live SSE feed carrying Human/Agent badges and one feed for both doors
- [x] Payer app — wallet, activity, and an agents console where the payer creates a PBM wallet, sets its policy and revokes it, signing every one of those transactions themselves
- [x] LLM-powered agent CLI (Gemini via the Vercel AI SDK) paying — and getting rejected on-chain — autonomously, with a visually-identical scripted fallback

### Deployed (Base Sepolia, `eip155:84532`)

| Contract | Address |
|---|---|
| [`GantryCore`](https://sepolia.basescan.org/address/0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0) | `0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0` |
| [`FixedRateSwap`](https://sepolia.basescan.org/address/0xEdcD7AcABb610543e1626F4453c9c4Ec8ABab713) | `0xEdcD7AcABb610543e1626F4453c9c4Ec8ABab713` |
| [`MockXSGD`](https://sepolia.basescan.org/address/0xd583FaB0Db5c543f5574780f8b899AEb74463361) | `0xd583FaB0Db5c543f5574780f8b899AEb74463361` |
| [`AgentPBMWalletFactory`](https://sepolia.basescan.org/address/0xd827C3445660a4D2d68c5D411DAbAE71B7fdcA05) | `0xd827C3445660a4D2d68c5D411DAbAE71B7fdcA05` |

The factory is permissionless: agent wallets are created *by the payer*, from the payer's own key, so their addresses are not constants — there is no wallet worth pinning here.

It was redeployed on 10 Aug 2026, when `AgentPBMWallet` gained an owner-set `label` and a `policyUpdatedAt` stamp. Wallets from the [previous factory](https://sepolia.basescan.org/address/0x172905F26F09b41636854338360315971240c1cf) still hold their funds and still enforce their policy on-chain; they are simply not enumerated, because the read path finds wallets through the current factory's `WalletCreated` logs.

The pay token is Circle's real testnet USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) — settled against live, and fork-tested too. Demo merchants `ah-hock-chicken-rice` (food & beverage) and `gadgethub-sg` (electronics — the rejection beat) are registered on-chain.

## Layout

```
packages/contracts   Foundry — GantryCore, AgentPBMWallet + factory, FixedRateSwap (IGantrySwap), mocks
packages/shared      ABIs (generated via `pnpm abis`), addresses, quote math, EIP-712 typed data, API types, formatting/profile/cursor helpers
packages/backend     Express — merchant API, relayer, SSE indexer, paged history + agent/denial reads, x402 facilitator (exact + gantry-pbm) + protected order route
packages/web         Next.js — landing /, onboarding /onboard, merchant back-office /merchant/[handle]/*, payer app /app/*, payer page /pay/[handle], shop page /m/[handle], printable QR /qr/[handle]
packages/agent       LLM agent CLI (Vercel AI SDK + Gemini) with scripted fallback (pnpm --filter @gantry/agent start "…")
```

Two surfaces, one rail. The **merchant back-office** (`/merchant/[handle]/{overview,transactions,payouts,qr,profile,settings}`) is what a hawker leaves open on the counter; the **payer app** (`/app`, `/app/{activity,agents,settings}`) is where a payer's wallet, history and agents live. `/dashboard` still redirects to the merchant screens, `?handle=` and all.

## Running locally

Needs Node ≥ 22.18 and pnpm 11 (`corepack enable` picks the pinned version up). Foundry is only needed to run contract tests or regenerate ABIs — the generated ABIs are committed, so the app runs without it.

Order matters: OpenZeppelin is an npm dependency, so `pnpm install` must run **before** `forge build`/`forge test` or the OZ imports will not resolve.

```bash
git submodule update --init                              # forge-std (contract tests only)
pnpm install
cp packages/backend/.env.example packages/backend/.env   # fill: RPC URL, relayer key, admin token
cp packages/web/.env.example packages/web/.env.local     # point NEXT_PUBLIC_* at your laptop's LAN IP
cp packages/agent/.env.example packages/agent/.env       # fill: AGENT_SESSION_KEY (+ optional Gemini key)
pnpm dev                                                 # backend :4000 + web :3000 (binds 0.0.0.0)
```

The relayer address needs Base Sepolia ETH — it is the only gas key in the system, so with an empty balance every settlement, registration and payer top-up fails. It doubles as the **funder**: payer accounts and agent PBM wallets are topped up by transferring real USDC out of its balance, so it needs USDC too, and the faucet sends a little ETH alongside so a payer can send the transactions they own (creating and configuring an agent — never paying a merchant, which stays gasless). `pnpm demo:reset` reports both balances and swaps ETH for USDC on Uniswap v3 when the USDC runs low. Nothing else needs deploying: the contracts are live and their addresses are pinned in `@gantry/shared`.

The variables that change **what the app does** — payer key source, agent autonomy, demo-vs-public host — are documented in **[docs/configuration.md](docs/configuration.md)**, along with the flows each combination produces. Plumbing (RPC URLs, ports, keys) is documented inline in the four `.env.example` files.

- **Phone demo:** put the phone on the same Wi-Fi, set `NEXT_PUBLIC_APP_URL`/`NEXT_PUBLIC_BACKEND_URL` to `http://<laptop-LAN-IP>:<port>`, open `/qr/ah-hock-chicken-rice`, scan, pay. Set `NEXT_PUBLIC_DEMO_KEY` to a `0x` private key for the in-browser demo account — auto-funded by the backend (a 4 USDC transfer from the relayer, which is why demo-account amounts cap at S$5), zero wallet setup. Unset or `0` means the payer connects their own wallet instead.
- **CLI smoke test:** `pnpm --filter @gantry/backend e2e:pay` (quote → EIP-3009 sign → settle → replay-rejection check).
- **Agent-door interop proof:** `pnpm --filter @gantry/backend x402:buy` — pays the 402-protected order endpoint with the unmodified vanilla `@x402/fetch` client and prints the decoded challenge + on-chain receipt.
- **Agent-door end-to-end:** `pnpm --filter @gantry/agent e2e:pbm` (note the package — it lives in the agent, not the backend), and the rejection beat with `pnpm --filter @gantry/agent e2e:pbm -- --handle gadgethub-sg --sgd 4 --expect-denial`.
- **Reset between rehearsals:** `pnpm demo:reset` — clears the transaction cache, provisions and re-arms the demo agent, re-seeds the demo merchant profiles, and prints addresses + demo URLs. It waits on real receipts, so budget seconds rather than milliseconds; contracts persist, so nothing is redeployed.
- **Onboard a merchant:** open `/onboard`, pick a handle (availability is checked against the chain as you type), fill in the shop's name, location and one-line blurb, paste a payout address, register. The relayer pays the gas, so the merchant needs no ETH. The handle, payout and category go on-chain; the three display fields are stored off-chain and are editable afterwards from the shop profile screen.
- **Agent CLI:** `AGENT_SESSION_KEY` cannot be a freshly generated key — its address must be the `agentSigner` of a PBM wallet that already exists, or the CLI has nothing to pay from (`GET /api/agents?agentSigner=…` is how it finds its wallet) and a mismatched key fails every payment with `InvalidAgentSignature`. Create the wallet from the payer app's agents screen with that address as the signer, or rotate an existing wallet's signer on-chain via `setAgentSigner`.
- Verify with `pnpm lint`, `pnpm typecheck`, `pnpm test:contracts`, `pnpm --filter @gantry/shared test`, `pnpm --filter @gantry/backend test`.

## Deploying

The two halves go to different hosts, and the split is forced: the dashboard
feed is a long-lived SSE stream, so the backend needs a host that keeps a
process alive.

| Half | Host | Live at | How |
|---|---|---|---|
| `packages/web` | Vercel | <https://gantry-innovatex.vercel.app> | Import the repo, set Root Directory to `packages/web`. Vercel detects Next.js; the only committed config is `packages/web/vercel.json`, whose single job is a filtered `pnpm install` so the build does not install the whole monorepo. |
| `packages/backend` | Render (free web service) | <https://gantry-backend.onrender.com> | Build `pnpm install --frozen-lockfile`, start `pnpm --filter @gantry/backend start`. No container. |

The backend **cannot** be serverless, and not only because of SSE: the relayer's
nonce counter, the faucet's cooldown/in-flight/daily-ceiling state, the merchant
registration and profile-edit cooldowns, and the cached factory and registration
scans all live in the process, and the indexer holds a WebSocket subscription
plus a 15s sweep. It must run as **exactly one long-lived instance** — never
autoscaled, or two of them will claim the same nonce and every rate limit halves
in effectiveness.

A persistent disk is *not* required for correctness — SQLite is a disposable
cache, and an indexer with no stored cursor re-sweeps from the deploy block in
1,999-block chunks (~89 `getLogs` chunks today, growing ~22 a day). One
caveat worth knowing: those chunks are sized for the public node's 2,000-block
ceiling, and Alchemy's free tier caps `eth_getLogs` at **ten** blocks, so every
chunk is refused by the paid endpoint and served by the rate-limited public one.
The other caveat is that merchant display names live off-chain in
`merchant_profiles`, the one table nothing can rebuild — losing the disk loses
the names of any shop that onboarded on the deployed host.

**The deployed instance is a shop window, not the demo.** The stage run happens
on the laptop, because payer funding and self-service onboarding only work on a
demo host. So Render's free-tier spin-down (~50s cold start) costs a browsing
screener a wait, not you a demo.

**The web build needs these set in the Vercel project before the first build.**
They are `NEXT_PUBLIC_*`, so they are inlined at build time, not read at runtime
— a missing one cannot be fixed without redeploying:

| Variable | Why it is not optional |
|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | Without it the app talks to `localhost:4000`, i.e. the visitor's own machine. This is the one that has actually been missed: the symptom is a browser permission prompt reading *"Access other apps and services on this device"* (Chrome's Local Network Access gate on a public origin reaching localhost) followed by "Can't reach the backend". |
| `NEXT_PUBLIC_APP_URL` | Baked into the printed QR by `/qr/[handle]`. Defaults to `http://localhost:3000`, which makes every QR the deployed site generates unscannable. |
| `NEXT_PUBLIC_DEMO_KEY=0x…` | **The one that is easy to miss.** Unset means the payer page only serves a connected wallet holding Base Sepolia USDC. A visitor scanning the QR would get a connect-wallet prompt and no way to pay — and the faucet's 20 USDC ceiling would be guarding a path nobody can reach. Being `NEXT_PUBLIC_*`, this key is inlined into the client bundle and readable in devtools, and it is **shared**: every visitor signs as the same payer and sees the same history. Testnet demo funds only, never the relayer's key. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Needed for the connect-wallet path alongside the demo account. |

On the backend, `NODE_ENV=production` is the only switch you need: it classifies
the host, and three unauthenticated affordances follow from that classification.
Self-service merchant onboarding switches **off**; unauthenticated merchant
profile editing switches **off**; the payer faucet is **capped** at 20 USDC and
0.01 ETH per rolling 24h across all addresses. All three spend the relayer's
balances for a caller nobody authenticated — the faucet transfers real USDC and
sends real gas, onboarding spends ETH and permanently claims a handle — and
`GantryCore` stores a single `onlyRelayer` address, so a deployed host and your
demo laptop are necessarily the same key.

They differ because the stakes do. Onboarding spends ETH and permanently claims
a handle, and nobody needs to onboard from their seat — so it is off, and
`/onboard` says so instead of rendering the form. It says exactly that, too:
nothing in Gantry reviews or verifies a merchant, so the card names the gas key
it is protecting rather than implying an approval queue. Profile
editing is off for a blunter reason: the route has no login at all, so on a
public host anyone could rewrite any shop's identity. Funding is capped rather
than off, because the demo account is what lets a visitor pay with no wallet at
all: five grants a day is enough to try it, and small enough that the ETH→USDC
top-up swap can replace the worst case (spending ETH from the same key to do it,
bounded by a per-swap cap). Point the web app's `NEXT_PUBLIC_BACKEND_URL` at the
deployed backend and set `CORS_ORIGIN` to the Vercel origin rather than `*`.

Check the result on the artefacts rather than on the page, because both halves
can look healthy while the pair is broken — the build vars are inlined, so a
value saved in Vercel after a build is not in the bundle that is serving:

```bash
curl -s https://gantry-backend.onrender.com/health                     # hostClass "public", lag small
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS \
  -H 'Origin: https://gantry-innovatex.vercel.app' \
  -H 'Access-Control-Request-Method: GET' \
  https://gantry-backend.onrender.com/api/merchants/ah-hock-chicken-rice   # 204, allow-origin echoes the Vercel origin
curl -s https://gantry-innovatex.vercel.app/qr/ah-hock-chicken-rice | grep -o 'https://[^"]*/pay/[a-z-]*'  # NEXT_PUBLIC_APP_URL
```

For `NEXT_PUBLIC_BACKEND_URL` there is no page that reports it, so grep the
shipped JavaScript: pull the chunk URLs out of any page's HTML and search them
for `onrender.com`. Finding `localhost:4000` instead means the var was missing at
build time and the fix is a **redeploy**, not a settings save.

## Docs

- [Configuration reference](docs/configuration.md) — the behaviour-changing env vars and the flows each produces
- [Architecture](docs/submission/architecture.md) — the two doors, the `IGantrySwap` seam, deployed addresses
- [Demo script](docs/submission/demo-script.md) · [Deck outline](docs/submission/deck-outline.md) · [Submission checklist](docs/submission/submission-checklist.md)

## Tech

Solidity ^0.8.24 (Foundry) · Base Sepolia (`eip155:84532`) · x402 v2 (`@x402/*`) · EIP-3009 gasless authorizations · viem/wagmi · Next.js 15 · Node 22 + Express · Vercel AI SDK + Gemini (agent tool loop)

## Honest notes

Everything that matters here runs for real: the contracts are deployed and verified on Base Sepolia, the x402 traffic is spec-shaped v2 that an unmodified `@x402/fetch` client pays, the EIP-3009 authorizations are checked against Circle's real testnet USDC, and the agent's policy denials are contract reverts — not backend `if` statements.

What is not real, and why:

- **`MockXSGD` — the only mocked token.** XSGD exists on no testnet (and not on Base), so testnet runs use a mock, labelled as such wherever it appears — the merchant settings screen lists it as "XSGD (testnet mock)". The mainnet path is real [XSGD](https://www.straitsx.com/) on a supported chain. Payments themselves settle in **real Circle USDC**: the payer signs an EIP-3009 authorization against Circle's own contract, and the demo payer account and agent wallets are funded by the relayer *transferring* real USDC rather than minting a mock.
- **The FX rate is owner-set**, not market-derived — `FixedRateSwap` behind the `IGantrySwap` interface. Production means real XSGD liquidity through an aggregator or RFQ behind that same interface; the seam is the part that's meant to survive.
- **One trusted relayer/facilitator key.** It pays all gas, and on the vanilla-x402 `exact` path it briefly custodies the agent's funds (one hop, PSP-style) because spec-compliant clients generate their own EIP-3009 nonce. The `gantry-pbm` path has no such hop. Merchant registration is relayer-paid too — permissionless on-chain, so it's faucet trust level.
- **Merchant categories are self-attested,** and so is everything the shop pages display. No KYC — the badge says "Registered on-chain", not "Verified". `GantryCore` stores the handle, the payout address and the category; the name, location and blurb are off-chain rows nobody checks. And no fiat off-ramp.
- **The merchant back-office has no login.** There is no merchant authentication anywhere in Gantry and we did not invent one, so anyone with the URL can read any shop's takings. On a demo host they can rewrite its profile text too; on a deployed host that write is closed, but the reads stay open.
- **The demo payer is a single shared account.** When the deployed build is configured with `NEXT_PUBLIC_DEMO_KEY`, every visitor signs with the same key — so the balance, the activity feed and the agent list are shared, and the payment history is not private. The payer app says so on screen. Connecting your own wallet is the private path.

This is a hackathon prototype — production would operate with a licensed PSP under Singapore's Payment Services Act.

## Team

Yashvardhan Jagnani ([@jagnani73](https://github.com/jagnani73)) — NTU
