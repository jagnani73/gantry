# Gantry — Project Guide

Hackathon project for NTU InnovateX 2026 (Track 1: Payments & Financial Infrastructure). Solo builder (NTU student, Student Group entry). This file is the canonical context for working sessions — read it fully before building.

## What Gantry is

A payer-agnostic payment rail on stablecoins. One on-chain `PaymentIntent`, one settlement contract, two doors:

- **Human door:** printed static QR encodes `…/pay/<handle>` → mobile payer page → payer signs an EIP-3009 `transferWithAuthorization` (gasless — tourist needs zero ETH) → relayer settles.
- **Agent door:** HTTP `402 Payment Required` with x402 v2 `PAYMENT-REQUIRED` header; `accepts[]` offers the standard `exact` scheme (any vanilla x402 client can pay) AND a custom `gantry-pbm` scheme (agent session key EIP-712 sig, executed through an on-chain policy wallet).

Both settle through `GantryCore._settle()`: pull funds → swap to XSGD if needed (min-out guard) → pay merchant → emit `IntentSettled`. Merchant dashboard shows both payer types landing in one live feed. That convergence IS the thesis — never build anything that exists for only one door except the thin encoding layers.

**Pitch line:** "x402 standardized how machines pay. Gantry is the rail that lets one merchant accept payments from machines and humans alike."

**Framing is strictly Singapore-centric:** XSGD settlement, hawker/tourist scenes, PayNow's structural gaps (no foreign payers, no agent payers), PBM framing after MAS Project Orchid.

## Hard deadlines

- **14 Aug 2026 ~6 PM SGT:** Stage 1 Devpost submission (deck PDF, 60–90s demo clip, this repo, architecture diagram, live dashboard link). Finished product NOT required — screening is on originality/feasibility/direction.
- **21–23 Aug 2026:** on-site finals at NTU — live 3-minute demo, working prototype.
- Judging: Technical Quality 30%, Real-World Impact 25%, Innovation 20%, Demo 15%, Track Relevance 10%.

Full plan (architecture, demo script, submission package, timeline): `C:\Users\yashj\.claude\plans\wanna-build-a-hackathong-pure-clarke.md`.

## Architecture (decided — do not relitigate without user)

**Contracts** (`packages/contracts`, Foundry, Solidity ^0.8.24, OZ only for ERC-20/Ownable):
- `GantryCore.sol` — merchant registry (`registerMerchant(handle, payout, categoryId)` = the 2-min onboarding, plus `setMerchantPayout` rotation gated on the current payout), `PaymentIntent` lifecycle, `settleWithAuthorization()` (QR + x402 `exact`; **EIP-3009 `nonce` must equal `intentId`** — binds signature to intent) and `settleFromPBM()` (Agent-door intents only); shared `_settle` with reentrancy guard, 0.5% protocol fee skim (`feeBps=50`, capped 2%); custom errors; `IntentSettled(intentId, merchantId, payer, tokenIn, amountIn, xsgdOut, feeXsgd, door)` — xsgdOut is gross, merchant receives xsgdOut − feeXsgd. Ownable2Step, renounce disabled.
- `AgentPBMWallet.sol` + factory — `owner` (human) funds it and sets `Policy {dailyCap, perTxCap, expiry, categoryBitmap}`; `agentSigner` is the agent's session key. `authorizeSpend()` (onlyCore) verifies EIP-712 sig + all policy dimensions + daily window. Custom errors `PerTxCapExceeded`, `DailyCapExceeded`, `CategoryNotAllowed(uint16)`, `PolicyExpired` — these exact names surface in the demo; facilitator returns them as x402 `invalidReason`.
- `GantrySwap.sol` — minimal x·y=k AMM (USDC/XSGD, 0.3% fee). Fuzz-test the invariant. Until it lands (M4), `FixedRateSwap.sol` (owner-set rate, seeded 1.3421) serves behind the same `IGantrySwap` interface — it stays as the cut-list fallback.
- `MockUSDC.sol` + `MockXSGD.sol` — both extend a shared hand-written `EIP3009` base (FiatToken-shaped: typehashes, `authorizationState`, events), 6 decimals, open mint. XSGD carries EIP-3009 deliberately: real XSGD supports x402 natively (StraitsX), and XSGD-direct settlement flows through the same authorization door. XSGD exists on NO testnet — mock is the honest option; label it.
- Primary pay token on Sepolia: Circle's real testnet USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (implements EIP-3009, has faucet). Fork-test against it from the start — EIP-3009 domain/sig quirks are a known risk.

**Backend** (`apps/backend`, Node 22 + Express + viem): merchant API; x402-protected routes via `@x402/express` pointed at our own facilitator; facilitator `/verify` + `/settle` (spec-shaped, `@x402/core` types, hand-rolled `gantry-pbm` handler); relayer (holds the only gas key — payers never send transactions); SSE indexer via `watchContractEvent` over WebSocket RPC. SQLite (better-sqlite3) as cache only — chain is source of truth. Pin `@x402/*` versions day one; vendor a ~50-line PAYMENT-REQUIRED/PAYMENT-SIGNATURE codec as insurance (v1→v2 churn risk; v1 examples online show old `X-PAYMENT` headers — ignore them).

**Web** (`apps/web`, Next.js 15 App Router + Tailwind + shadcn/ui + wagmi v2 + RainbowKit): onboarding wizard, printable QR page (`@media print`), payer page `pay/[handle]`, merchant dashboard (live SSE feed with chime + Human/Agent badges, FX drawer, policy panel with cap meter + Revoke, summary strip). Payer page: ONE signing path (EIP-3009 typed data), TWO key sources — real wallet-connect (product UX, demo clip) and embedded pre-funded burner key behind an env/query flag (deterministic on-stage mode).

**Agent** (`apps/agent`, `@anthropic-ai/sdk`, model `claude-opus-5`, beta tool runner, streaming): terminal CLI; tools `list_merchants`, `check_my_policy`, `pay_merchant` (deterministic HTTP + signing inside the tool; the LLM narrates). 8s LLM timeout → scripted reasoning fallback, visually identical. Separate tiny script pays via unmodified `@x402/fetch` (standard-interop proof).

**Chain/infra:** Base Sepolia (`eip155:84532`); Alchemy RPC primary + public/QuickNode fallback, env-switchable; `DEMO_MODE=local` runs everything against a local Anvil fork (same contracts/UI, zero internet) — the stage demo runs local over a laptop hotspot; Sepolia deployment is real and Basescan-verified for authenticity. Hosting: Vercel (web) + Railway/Fly (backend — needs long-lived SSE).

## Canonical demo facts (bake into seed data / `demo-reset` script)

- Merchant: **"Ah Hock Chicken Rice"**, Maxwell Food Centre, category `food_beverage`.
- Human payment: S$6.50 → 4.84 USDC → 6.50 XSGD @ 1.3421 (seed the pool to produce this rate).
- Agent payment: team lunch 3× = S$19.50 (14.53 USDC).
- Agent policy: S$50/day cap, categories `[food_beverage]`, 30-day expiry, revocable.
- Rejection beat: "GadgetHub SG" (`electronics`), S$29 powerbank → on-chain revert `CategoryNotAllowed`.
- Fee story: Gantry 0.5% (S$0.13 on the day's S$26) vs ~2.8% cards (S$0.72).
- `demo-reset` = one command: deploy, mint, fund wallets, seed pool, register merchant + policy, clear dashboard, print addresses. Must run <30s — it enables rehearsal.

## Milestones & cut list

M0 (Aug 4–5) contracts core + Sepolia deploy → M1 (6–7) QR spine e2e — **the demo spine; everything after is additive** → M2 (8–9) x402 door + `@x402/fetch` interop → M3 (10–11) PBM + Claude agent + on-chain denial → M4 (12–13) swap + onboarding + Stage 1 materials; build freeze 12 Aug EOD; clip recorded 13 Aug AM; submit 14 Aug. Then hardening + ≥10 rehearsals before finals.

Cut in this order if behind: AMM→fixed-rate; onboarding wizard→single form; `@x402/fetch` beat; live Claude→scripted agent (wire traffic stays real). **Never cut:** QR flow, GantryCore settlement, live dashboard feed.

## Status: M0 complete + review-hardened (5 Aug 2026)

Contracts core is live and Basescan-verified on Base Sepolia; 88 unit tests (incl. fuzz) + 4 fork tests vs real Circle USDC, all green. The M0 review gate ran (5 agents) and all findings were fixed and redeployed. Relayer/owner = deployer `0x82513007C7eB93b54dC555Bdb74341b3084FC47B`. Demo merchant `ah-hock-chicken-rice` (category 1) registered on-chain; fee = 50 bps to deployer; FixedRateSwap has rates listed for MockUSDC AND real Circle USDC.

| Contract | Base Sepolia address |
|---|---|
| GantryCore | `0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0` |
| FixedRateSwap | `0xEdcD7AcABb610543e1626F4453c9c4Ec8ABab713` |
| MockUSDC | `0x5F7F058F2B1572524d1E3E740656CfAd1Ab011F9` |
| MockXSGD | `0xd583FaB0Db5c543f5574780f8b899AEb74463361` |

Design notes that bind later milestones: intents are relayer-created with pinned `tokenIn/amountIn` quotes (requote = cancel + recreate; relayer must only quote no-fee-on-transfer tokens and must CEIL the amountIn quote — fuzz-proven in FixedRateSwap.t.sol); `intentId = keccak256(chainid, core, merchantId, nonce)` doubles as the EIP-3009 nonce; settlement callers are permissionless; `settleFromPBM` accepts only Agent-door intents while `settleWithAuthorization` serves both doors (x402 `exact` = Agent via auth door); min-out is enforced via the core's own XSGD balance delta and the swap allowance is reset after each settle; 0.5% fee skimmed in `_settle` (xsgdOut in `IntentSettled` is gross); categories are `uint16 < 256` for a future one-word policy bitmap; real-USDC EIP-712 domain confirmed ("USDC", "2") and its revert strings are pinned in fork tests. FixedRateSwap accepts only tokens with an owner-listed rate (per-1e6-unit scale, 6dp stables only). Known accepted vector: raw EIP-3009 sig front-run to the token strands funds in core → `rescueERC20` sweep (owner-only; ownership is 2-step and unrenounceable).

## Status: M1 complete + review-hardened (5 Aug 2026)

The QR spine is live end-to-end on Base Sepolia: printed QR → `/pay/[handle]` → EIP-3009 sign (burner or wallet-connect) → relayer settles → dashboard SSE row <2s. Verified in-browser and via the CLI harness (`pnpm --filter @gantry/backend e2e:pay`). The M1 review gate ran (5 agents); all four fix bundles were applied. TS tests: 16 shared + 9 backend, all green.

**What exists:** `packages/shared` (committed generated ABIs via `pnpm abis`, addresses, ceil quote math, EIP-3009 typed-data builders, structural error decoding); `apps/backend` (Express 5 + viem: `/health`, merchant lookup, quote-pinned intent creation, settle, requote, faucet, SSE `/api/events`, admin reset); `apps/web` (Next 15: payer page state machine, dark dashboard with chime + Human/Agent badges + summary strip, printable QR). `pnpm demo:reset` clears the cache <1s (full Anvil orchestration is M4; CHAIN_ID=31337 plumbing already built).

Design notes that bind M2/M3:
- **Wire conventions:** all amounts are 6dp-unit decimal strings; display timestamps (`expiry`, `blockTime`) are unix-second numbers; **`validAfter`/`validBefore` are uint256 decimal strings** that must byte-match the signed typed data (x402 `exact` carries them as strings). `IntentResponse` field names are deliberately x402 vocabulary (tokenIn=asset, amountIn=amount, payTo=core, intentId=authorization nonce). *(Superseded in M2: the agent door prices its 402 independently via the facilitator bridge — see M2 status.)*
- **`settlement.settle()` is the reusable settle path** M2's facilitator must call — stateless-capable (explicit `validAfter`/`validBefore`, DB fallback). It retries only `isStaleStateRevert` shapes (lagging-replica UnknownIntent / fresh-balance insufficient), 5×1.2s, logged.
- **M3 MUST spread the AgentPBMWallet errors ABI into `gantryErrorsAbi`** (packages/shared/src/errors.ts) or `CategoryNotAllowed` & co decode as `unknown` and the rejection beat dies. `GantryErrorName` gives compile-time checked names.
- `validBefore = expiry + 120s` (bounds the accepted raw-sig front-run window). Intent TTL 600s from **block** timestamp.
- **Indexer:** WS `watchContractEvent` = latency path; 15s `getLogs` sweep from the persisted cursor = correctness path and sole cursor owner; admin reset bumps an epoch that aborts in-flight sweeps (prevents cleared rows resurrecting). SSE replay via `Last-Event-ID` = `block:logIndex`; settlements dedup on `(tx_hash, log_index)`.
- **Relayer:** single FIFO queue owns the nonce (local counter, resync on any failure incl. receipt timeout; 20s receipt cap); simulate-before-send everywhere; wallet client has RPC fallback.
- SQLite is a disposable cache (`db-core.ts` factory; stored statuses only pending/settled/cancelled — expired/unknown are computed; ids lowercased on write).
- **Burner:** `NEXT_PUBLIC_BURNER_KEY` = deterministic stage mode; else per-device localStorage key + backend faucet (100 MUSDC, payer page caps burner at S$130). Backend `DEFAULT_TOKEN` env (USDC rejected at boot on 31337). `door` is client-supplied on `POST /api/intents` for now — *(done in M2: door is route-derived; the client field is gone)*.

## Status: M2 complete + review-hardened (6 Aug 2026)

The x402 agent door is live end-to-end on Base Sepolia: `POST /api/order/:handle?sgd=…` 402-challenges with a spec-shaped v2 `PAYMENT-REQUIRED`, an **unmodified vanilla `@x402/fetch` client pays it** (the interop beat), and the settlement lands in the same dashboard feed as QR payments with the Agent badge. The M2 review gate ran (5 agents); all agreed findings fixed. Tests: 21 shared + 20 backend, plus live e2e (curl decode, vanilla buy, SSE both-doors, replay/tamper/broke-payer reasons).

**The load-bearing M2 discovery:** vanilla x402 v2 `exact` clients random-generate the EIP-3009 nonce (`createNonce()` in `@x402/evm`; no pinning extension), but the frozen core hardcodes `nonce = intentId`. A literally-unmodified client can therefore never sign what `settleWithAuthorization` settles. **User-approved design: the facilitator bridge** — accepts[] is 100% spec-standard with `payTo = relayer`; at settle the bridge creates the Agent-door intent, collects the agent's authorization onto the relayer (`transferWithAuthorization`, no pre-float), relayer self-signs an EIP-3009 auth with `nonce = intentId`, and settles via the M1 `settlement.settle()`. On-chain payer is the relayer (one custodial hop, PSP-style — on the honest-labels list); the agent's address travels in `PAYMENT-RESPONSE` and on SSE rows as `agentPayer` (“via facilitator” in the UI).

**What exists:** `packages/shared/src/x402.ts` (owned v2 wire types + base64 header codec, zero `@x402` imports — churn insurance; `Caip2Network` template type keeps the SDK boundary compiler-checked) and `abis/eip3009Token.ts` (hand-written collect/refund ABI fragment). Backend: `services/facilitator-core.ts` (pure, config-free: payload schema, `validateExactPayment`, `parseOrderPins`, `splitSignature65`, `reasonForGantryError`), `services/facilitator.ts` (verify + chain reads with a bounded balance-lag retry — same replica-lag class M1 retries in settle), `services/bridge.ts` (the bridge + outcome resolution), `routes/facilitator.ts` (spec HTTP surface: GET `/facilitator/supported`, POST `/verify`+`/settle`, in-band failures), `routes/order.ts` (DynamicPrice + receipt handler), `src/x402.ts` (`@x402/express` middleware wired to an **in-process** `FacilitatorClient` — the SDK syncs `/supported` at construction pre-listen, and its HTTP client's default 30s timeout can't cover three serialized txs). `scripts/x402-buy.ts` = the vanilla-client proof (`pnpm --filter @gantry/backend x402:buy`). Deps pinned exact `@x402/{core,evm,express,fetch}@2.21.0`. `ORDER_TOKEN` env (default: real USDC when the chain has it, else MUSDC; demo runs MUSDC + faucet — real-USDC runs need a Circle-faucet-funded `X402_PAYER_KEY`).

Design notes that bind M3/M4:
- **Trust channel:** the bridge's order facts (`handle`, `xsgdAmount`) come ONLY from server-pinned `requirements.extra` (the SDK subset-matches extra against the client echo; the client-echoed `resource.url` is never load-bearing — a client could echo another merchant's URL at the same price). Any new scheme handler must follow this rule.
- **Compensation invariant:** never assume "the relayer helper threw ⇒ the tx did not happen" — receipt timeouts leave broadcast txs that may mine. The bridge proves outcomes on-chain before refunding: `authorizationState` reads + the cancel-tx nonce-ordering trick (a cancel that lands proves the stuck tx was consumed; `IntentAlreadySettled` on cancel proves settlement won). Unresolved outcomes get CRITICAL logs with manual-recovery data, never blind refunds.
- **M3 `gantry-pbm`** = a second entry in the same route's accepts[] + a second scheme handler beside `exact` in the facilitator services; settlement via `settleFromPBM` puts the PBM wallet on-chain as payer (no bridge, non-custodial — the purity story lives there). MUST spread the AgentPBMWallet errors ABI into `gantryErrorsAbi` or `CategoryNotAllowed` & co decode as `unknown`; `reasonForGantryError` already passes custom names through verbatim (unit-pinned for `CategoryNotAllowed`).
- **x402 error vocabulary:** snake_case protocol reasons (`invalid_signature`, `insufficient_funds`, `authorization_already_used`, `quote_changed`, `invalid_requirements`…) + Gantry custom error names passed through verbatim; Circle's "used or canceled" string maps to `authorization_already_used`; everything else collapses to `settlement_failed` with detail in `errorMessage`.
- **M4 AMM warning:** `buildOrderPrice` must stay deterministic between challenge and retry (the middleware deep-equal-matches rebuilt requirements). The owner-set FixedRateSwap satisfies this; GantrySwap's moving rate breaks it — M4 needs a short-lived quote pin in the price fn.
- Bridge compensation paths (settle-fails-after-collect → cancel+refund) have no automated coverage — becomes a cheap fork test once M4's Anvil orchestration exists.
- SQLite gained `agent_payer` on intents + settlements (ALTER-migrated in place; cache stays disposable).

## What's real vs mocked (keep these labels honest everywhere)

Real: all contracts on Sepolia, x402 v2 wire format, EIP-3009 vs real Circle USDC, on-chain PBM denials (contract reverts — never backend if-statements), AMM slippage math, Claude tool-use decisions, real phone + printed QR.
Mocked: MockXSGD (no testnet XSGD), self-seeded FX pool (no oracle), single trusted relayer/facilitator key (including the exact-scheme bridge's one-hop custody of agent funds), self-attested merchant categories (no KYC), no fiat off-ramp.

## Conventions

- pnpm workspaces monorepo. TypeScript everywhere outside `packages/contracts`.
- Everything on `main`, incremental focused commits, Conventional Commits (`feat(contracts): …`). No AI co-author trailers.
- Verify with `pnpm lint` + `tsc --noEmit` (and `forge test` for contracts), not full builds.
- **Milestone review gate:** before declaring any milestone (M0–M4) done, run the PR review skill (`pr-review-toolkit:review-pr`) over the milestone's full commit range (e.g. `git diff <last-milestone-tag-or-commit>..HEAD`), triage findings with the user, and fix agreed ones before sign-off. Same applies to any large multi-commit change outside milestones.
- Repo is public from day 1 — commit history is feasibility evidence for screeners. Keep `.env.example` current.
- Demo-script-driven development: if it doesn't appear in the demo script or submission materials, don't build it.
