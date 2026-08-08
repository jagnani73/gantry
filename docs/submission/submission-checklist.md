# Stage 1 submission checklist (DRAFT for review)

**Target: submit 11 Aug EOD.** The external cutoff is 14 Aug ~6 PM SGT and is a
backstop only — never the plan. Screening judges originality, feasibility and
direction; a finished product is explicitly not required.

## Package, in priority order

Cut from the bottom if time runs short.

| # | Artifact | Status | Owner date |
|---|---|---|---|
| 1 | Deck PDF (10 slides — `deck-outline.md`) | outline drafted | 10 Aug PM |
| 2 | Demo clip, 60–90s, unlisted YouTube (`demo-script.md`) | script drafted | record 10 Aug AM, upload PM |
| 3 | Public GitHub repo with real commit history | **PRIVATE — must flip** | before submit |
| 4 | Architecture diagram PNG (`architecture.md`) | mermaid source drafted | 10 Aug PM |
| 5 | Live merchant back-office URL (Vercel) + Basescan contract links | **not deployed yet** | 10 Aug |
| 6 | Team details + NTU proof of student status | **not requested yet** | ASAP |

## Still to do

- [ ] **Request the NTU enrolment certificate.** Longest lead time of anything
      on this list and entirely outside our control. Do this first.
- [ ] Deploy web to **Vercel** (Root Directory `packages/web`; the committed
      `packages/web/vercel.json` only narrows the install to that package) and
      backend to **Render** as a free web service — one instance, never
      autoscaled, because SSE, the relayer nonce and every rate limit are
      in-process. Neither has been run against a real host yet, so budget time
      for a first deploy to fail on something small.
- [ ] Point `NEXT_PUBLIC_BACKEND_URL` at the deployed backend and set
      `CORS_ORIGIN` to the Vercel origin instead of `*`.
- [ ] **Rotate the Gemini API key, then make the repo public** — in that order.
      The repo is currently PRIVATE, but a public GitHub repo is one of the five
      submission artifacts, so screeners would hit a 404. The key transited a
      chat; rotating after flipping visibility is rotating too late.
- [ ] Confirm the deployed backend runs with `NODE_ENV=production`. It is the
      single host-class switch: it **caps** the payer faucet at 20 USDC and
      0.01 ETH per rolling 24h across all addresses (it does not close it —
      demo-account payments must still work for a judge), switches self-service
      onboarding OFF, and closes unauthenticated merchant-profile editing.
- [ ] Set the Vercel build vars before the first build:
      `NEXT_PUBLIC_DEMO_KEY=0x…`, `NEXT_PUBLIC_APP_URL`,
      `NEXT_PUBLIC_BACKEND_URL`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`. Miss the
      demo key and the deployed payer page cannot take a payment at all. Use a
      throwaway testnet key and know what you are shipping: it is inlined into
      the client bundle and shared by every visitor.
- [ ] Fund the deployed build's demo account with a little ETH as well as USDC,
      or its agents screen cannot sign anything — `setPolicy`/`revoke` are the
      payer's own transactions now. (The faucet's gas leg does this
      automatically; confirm it is not sitting against its 24h ceiling.)
- [ ] Export the mermaid diagram to PNG and check it reads at thumbnail size.
- [ ] Print slide 1 and confirm the QR scans off a projected image, not just
      off a screen.
- [x] CI badge in the README, backed by `.github/workflows/ci.yml` (lint,
      typecheck, shared + backend tests, `forge test`). Confirm it goes green on
      the first push — it has never run on a runner.
- [ ] Tag `stage1-submission` when the package is final.
- [ ] Record per-beat backup clips and one full-run backup video (11–12 Aug).

## Devpost copy anchors

- **One-liner:** One rail, every payer: QR for humans, x402 for AI agents.
- **Elevator paragraph:** lead with PayNow's tourist gap and the agent gap, close
  on feasibility — "a working prototype runs on Base Sepolia today", with the
  Basescan link inline.
- **Track:** 1 — Payments & Financial Infrastructure.
- **Entry:** Student Group (solo). Claim Best Student Team explicitly.

## Screening risks and what counters each

| Risk | Counter, and where it lives |
|---|---|
| "Generic crypto payment gateway" | The payer-type × rail matrix leads the deck (slide 2) |
| "The AI agent part is a gimmick" | x402 is a Linux Foundation standard, an unmodified client pays us, and the denial is a real revert (slide 6) |
| "Vaporware" | Basescan links, live dashboard, commit graph, scannable QR on slide 1 (slides 1, 8) |
| "Hand-waves regulation" | Slide 9's modest posture: licensed PSP in front, Gantry as rail |
| "Solo builder can't execute" | Visible scope discipline — the skipped AMM is *documented as skipped*, not hidden |

## Timeline

| Date | What |
|---|---|
| 9 Aug EOD | **Build freeze.** No features after this |
| 10 Aug AM | Record the final clip |
| 10 Aug PM | Edit and upload, export deck PDF and diagram PNG, README pass, tag |
| 11 Aug | Fresh-eyes review, **submit by EOD** |
| 11–12 Aug | Hardening, ≥10 rehearsals, backup clips |
| 12 Aug night | **Everything done** |
| 13–20 Aug | Intentionally empty — slip buffer only |
| 21–23 Aug | Finals at NTU, live 3-minute demo |

## Claims that must not drift

Cross-check every artifact against this before submitting. Each of these has
been wrong in a draft at least once.

- **Payments settle in real Circle USDC** (`0x036CbD…`), not a mock. The payer
  signs an EIP-3009 authorization against Circle's own contract, and the demo
  payer account and agent wallets are funded by the relayer *transferring* real
  USDC — not minting. `MockXSGD` is the only mocked token, because XSGD exists on
  no testnet.
- **The demo prices are hawker-drink scale:** iced tea **S$1.50** (1.117652
  USDC), three iced teas **S$4.50** (3.352955 USDC), the rejected phone cable
  **S$4**. The old S$19.50 lunch / S$29 powerbank figures survive only as
  arithmetic fixtures in the test suites — never quote them.
- The fee story runs on the demo day's **S$6.00**: Gantry S$0.03, cards S$0.168.
  The Settlements screen renders net **S$5.97** ("Collected today") and
  **S$0.13** ("Saved vs cards") — the S$0.13 is the *saving*, not our cut. Never
  say "we took thirteen cents".
- **Agent PBM wallets are owned on-chain by the payer.** `setPolicy` and
  `revoke` are `onlyOwner`, signed in the payer's browser; Gantry holds no key
  that can change a policy. Revoke lives in the payer app (`/app/agents`), not on
  the merchant screens. Wallets are created by the payer through the
  permissionless factory, so `0xDD4bbed7…` is the *first* demo wallet, not *the*
  wallet.
- **There are two surfaces**: the merchant back-office at
  `/merchant/[handle]/…` and the payer app at `/app/…`. `/dashboard` is a
  redirect, not a screen; `/agent` no longer exists.
- The agent-door end-to-end script is `pnpm --filter **@gantry/agent** e2e:pbm`.
  Its siblings `e2e:pay` and `x402:buy` are `@gantry/backend`.
- Agent runs **Gemini** `gemini-flash-latest` via the Vercel AI SDK, not Claude.
- Live demo runs on **Base Sepolia over a hotspot**. Local Anvil was deferred
  and never built — don't describe it as a fallback we have.
- **GantrySwap does not exist.** `FixedRateSwap` ships behind the `IGantrySwap`
  interface, the rate is owner-set, and there is no AMM and no slippage.
- The agent door has **two** sub-paths: standard `exact` is custodial (one
  relayer hop), `gantry-pbm` is not.
- Contracts are named `GantryCore` and `AgentPBMWallet`. `SettlementRouter` and
  `PolicyGuard` appear in old planning notes and never existed in code.
