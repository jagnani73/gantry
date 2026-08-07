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

- **12 Aug 2026 night (EOD SGT):** EVERYTHING done (reset 6 Aug 2026) — build freeze 9 Aug EOD, Stage 1 materials 10 Aug, Devpost submission 11 Aug EOD, hardening + ≥10 rehearsals + backup clips by 12 Aug night. 13–20 Aug is intentionally empty (slip buffer only).
- **14 Aug 2026 ~6 PM SGT:** Stage 1 Devpost submission hard cutoff — backstop only, we submit 11 Aug (deck PDF, 60–90s demo clip, this repo, architecture diagram, live dashboard link). Finished product NOT required — screening is on originality/feasibility/direction.
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

**Chain/infra:** Base Sepolia (`eip155:84532`); Alchemy RPC primary + public/QuickNode fallback, env-switchable; deployment is real and Basescan-verified for authenticity. The stage demo runs against Sepolia over a laptop hotspot. Anvil local mode (`DEMO_MODE=local` against a local fork) is **deferred, not built** (6 Aug 2026): its orchestration cost lands in M4, the heaviest milestone, and the hotspot already covers the venue-network failure mode — insurance that costs the thing it insures isn't good insurance. The CHAIN_ID=31337 plumbing (config branches, `ANVIL_CHAIN_ID`) stays as-is, inert. Revisit only if hotspot+Sepolia rehearsals (11–12 Aug) hit RPC flakiness — the fix would land in the otherwise-empty 13–20 Aug slip buffer. Hosting: Vercel (web) + Railway/Fly (backend — needs long-lived SSE).

## Canonical demo facts (bake into seed data / `demo-reset` script)

- Merchant: **"Ah Hock Chicken Rice"**, Maxwell Food Centre, category `food_beverage`.
- Human payment: S$6.50 → 4.84 USDC → 6.50 XSGD @ 1.3421 (seed the pool to produce this rate).
- Agent payment: team lunch 3× = S$19.50 (14.53 USDC).
- Agent policy: S$50/day cap, categories `[food_beverage]`, 30-day expiry, revocable.
- Rejection beat: "GadgetHub SG" (`electronics`), S$29 powerbank → on-chain revert `CategoryNotAllowed`.
- Fee story: Gantry 0.5% (S$0.13 on the day's S$26) vs ~2.8% cards (S$0.72).
- `demo-reset` = one command, Sepolia-based: clear the dashboard cache; contracts persist on-chain and the relayer holds gas ETH. Must run <30s — it enables rehearsal. (The full deploy/mint/fund/seed orchestration returns only if Anvil local mode is revived — deferred 6 Aug 2026, see Chain/infra.)

## Milestones & cut list

Schedule reset 6 Aug 2026 (M0–M2 landed ahead of plan; everything done by 12 Aug night): M0 (done 5 Aug) contracts core + Sepolia deploy → M1 (done 5 Aug) QR spine e2e — **the demo spine; everything after is additive** → M2 (done 6 Aug) x402 door + `@x402/fetch` interop → M3 (done 7 Aug) PBM + Claude agent + on-chain denial → M4 (Aug 8–9) swap + onboarding + Stage 1 materials; build freeze 9 Aug EOD; clip recorded 10 Aug AM, materials finalized 10 Aug PM; fresh-eyes review + submit 11 Aug EOD (14 Aug external cutoff = backstop only); hardening + ≥10 rehearsals + backup clips 11–12 Aug — **everything done 12 Aug night**; 13–20 Aug empty (slip buffer only); finals prep is venue-only.

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

**What exists:** `packages/shared` (committed generated ABIs via `pnpm abis`, addresses, ceil quote math, EIP-3009 typed-data builders, structural error decoding); `apps/backend` (Express 5 + viem: `/health`, merchant lookup, quote-pinned intent creation, settle, requote, faucet, SSE `/api/events`, admin reset); `apps/web` (Next 15: payer page state machine, dark dashboard with chime + Human/Agent badges + summary strip, printable QR). `pnpm demo:reset` clears the cache <1s (Anvil orchestration deferred 6 Aug 2026 — see Chain/infra; CHAIN_ID=31337 plumbing built and retained inert).

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
- **Trust channel:** the bridge's order facts (`handle`, `xsgdAmount`) come ONLY from server-pinned `requirements.extra` (the SDK subset-matches extra against the client echo; the client-echoed `resource.url` is never load-bearing — a client could echo another merchant's URL at the same price). Any new scheme handler must follow this rule. *(M3's pbm handler follows it.)*
- **Compensation invariant:** never assume "the relayer helper threw ⇒ the tx did not happen" — receipt timeouts leave broadcast txs that may mine. The bridge proves outcomes on-chain before refunding: `authorizationState` reads + the cancel-tx nonce-ordering trick (a cancel that lands proves the stuck tx was consumed; `IntentAlreadySettled` on cancel proves settlement won). Unresolved outcomes get CRITICAL logs with manual-recovery data, never blind refunds. *(M3's pbm settle wrapper inherits this.)*
- ~~**M3 `gantry-pbm`** = a second entry in the same route's accepts[]…~~ *(done in M3 exactly as specified — see the M3 status section)*.
- **x402 error vocabulary:** snake_case protocol reasons (`invalid_signature`, `insufficient_funds`, `authorization_already_used`, `quote_changed`, `invalid_requirements`…) + Gantry custom error names passed through verbatim; Circle's "used or canceled" string maps to `authorization_already_used`; everything else collapses to `settlement_failed` with detail in `errorMessage`. M3 adds pbm verify-stage reasons (`unknown_intent`, `intent_expired`, `intent_mismatch`, `intent_already_settled`, `intent_cancelled`, `network_error`) and agent-client-side ones (`transport_error`, `outcome_unknown` — the latter means "may have settled; never retry").
- **M4 AMM warning:** `buildOrderPrice` must stay deterministic between challenge and retry (the middleware deep-equal-matches rebuilt requirements). The owner-set FixedRateSwap satisfies this; GantrySwap's moving rate breaks it — M4 needs a short-lived quote pin in the price fn. BOTH accepts entries share `buildOrderPrice`, so one pin fixes both.
- Bridge compensation paths (settle-fails-after-collect → cancel+refund) have no automated coverage — becomes a cheap fork test only if Anvil orchestration is revived (deferred 6 Aug 2026). Same accepted gap for M3's `resolveFailedPbmSettle` (lower stakes: nothing custodied).
- SQLite gained `agent_payer` on intents + settlements (ALTER-migrated in place; cache stays disposable).

## Status: M3 complete + review-hardened (7 Aug 2026)

The non-custodial agent door is live end-to-end on Base Sepolia: the agent CLI pays S$19.50 at ah-hock via `gantry-pbm` (on-chain payer = the PBM wallet, no custodial hop, no `agentPayer` on the row) and the S$29 GadgetHub powerbank dies as an on-chain `CategoryNotAllowed(2)` revert that surfaces verbatim as the x402 `errorReason` — narrated by the agent. The M3 review gate ran (5 agents); all four fix bundles were applied. Tests: 162 forge (incl. policy fuzz + real-USDC fork), 28 shared, 32 backend; both regressions green (`x402:buy` vanilla exact, `e2e:pay` human QR).

| Contract | Base Sepolia address |
|---|---|
| AgentPBMWalletFactory | `0x172905F26F09b41636854338360315971240c1cf` |
| AgentPBMWallet (demo) | `0xDD4bbed78B64715288bf10fabB2b62c659299D3E` |

**What exists:** `AgentPBMWallet.sol` (+permissionless factory) — `Policy {uint128 dailyCap, uint128 perTxCap, uint40 expiry, uint256 categoryBitmap}`, EIP-712 `SpendAuthorization(bytes32 intentId,address token,uint256 amount)` under domain `{AgentPBMWallet, 1, chainId, wallet}`, check order sig→expiry→category→perTx→daily→balance (test-pinned; names are read on stage), **`setPolicy` resets `spentToday`** (the rehearsal re-arm — demo-reset calls it via `POST /api/admin/policy/arm`), `revoke()` zeroes the policy (expiry 0 ⇒ `PolicyExpired`, no separate error), caps in token units (S$ is display conversion via rate — honest label), no per-intent ledger (replay leans on the core's Settled-flip; test-documented). Backend: `services/schemes.ts` is the single scheme dispatch both surfaces call; `verifyPbm` (live agentSigner+CORE reads with transport-vs-revert distinction, chain-time expiry margin, intent-vs-pins match via pure `pbmIntentMismatch` in pbm-core — DB row + chain struct normalize to one tested matcher); `settlePbm` shares the replay guard + stale-retry helper with the exact path; `services/pbm.ts` = the bridge's non-custodial sibling (denial → simulate revert → decode → `tryCancelIntent` → errorReason; ambiguous outcomes proven on-chain, nothing custodied). `POST /api/pbm/intent` pre-creates the Agent-door intent the sig must bind (labeled relayer-gas vector, faucet trust level). Agent CLI (`apps/agent`): claude-opus-5 beta tool runner, streaming; tools do all HTTP+signing (session key in env.ts, structurally LLM-unreachable); 8s no-stream timeout → scripted fallback (same tool fns + typewriter, visually identical) hard-gated on `toolCallsStarted === 0` with live-tool lockout — a payment can never run twice; `payMerchant` never throws (transport failures → `transport_error`/`outcome_unknown` results). Dashboard policy panel (cap meter from `SpendAuthorized.spentTodayAfter`-backed reads, rate-labeled S$, revoke with surfaced errors); demo-reset re-arms policy + token-aware faucet top-up + gadgethub check.

Design notes that bind M4:
- **The cross-stack EIP-712 vector** (`agentPolicy.test.ts` ↔ `test_crossStack_digestVector`, digest `0x1439a3cf…`) pins the TS builder against LIVE contract code (deployCodeTo + live DOMAIN_SEPARATOR/typehash reads via PbmDigest). It is an ENCODING pin with hardcoded literals — do NOT "fix" it to read from addresses.ts on a redeploy.
- **`exact` stays accepts[0]** — boot-time assert in routes/order.ts; vanilla clients take the first entry.
- **Never blanket-retry wallet errors:** `isStaleStateRevert` excludes `PBMPullFailed`/`InsufficientWalletBalance`/policy denials (negatively test-pinned).
- **`POLICY_ADMIN_ENABLED=0` on public hosts** — the revoke route is a demo kill switch (30s cooldown regardless); the stage revoke runs against the demo laptop's own backend.
- **`ORDER_TOKEN=MUSDC` everywhere for the demo** — the wallet is MUSDC-funded and the faucet can only mint MUSDC; demo-reset warns (token-aware) if the order token diverges.
- Live-LLM agent mode needs `ANTHROPIC_API_KEY` in `apps/agent/.env` (unset ⇒ scripted mode, same beats); `AGENT_SESSION_KEY` lives there too — its address is the wallet's on-chain `agentSigner`.
- Deferred by triage (recorded, not lost): tri-state `PolicyResponse.status` (naturally-lapsed policy renders as active while spends revert — doc'd on the type), per-IP cooldown on `/api/pbm/intent`, `toWireSpendAuthorization` overloads.

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
