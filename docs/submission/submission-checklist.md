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
| 5 | Live merchant back-office URL (Vercel) + Basescan contract links | **deployed and wired 9 Aug** — see Live URLs below | 10 Aug |
| 6 | Team details + NTU proof of student status | **not requested yet** | ASAP |

## Live URLs

Paste these verbatim into Devpost, the deck's slide 8 and the repo README.

| | URL |
|---|---|
| Merchant back-office | <https://gantry-innovatex.vercel.app/merchant/ah-hock-chicken-rice/overview> |
| Payer app | <https://gantry-innovatex.vercel.app/app> |
| Payer page (what the printed QR opens) | <https://gantry-innovatex.vercel.app/pay/ah-hock-chicken-rice> |
| API health | <https://gantry-backend.onrender.com/health> |

Render's free tier spins an idle instance down, so the first hit after a quiet
spell takes ~50s. Warm the backend before sending anyone the link, and warm it
again right before any live walkthrough.

## Still to do

- [ ] **Request the NTU enrolment certificate.** Longest lead time of anything
      on this list and entirely outside our control. Do this first.
- [x] Deploy web to **Vercel** (Root Directory `packages/web`; the committed
      `packages/web/vercel.json` only narrows the install to that package) and
      backend to **Render** as a free web service — one instance, never
      autoscaled, because SSE, the relayer nonce and every rate limit are
      in-process. Done 9 Aug.
- [x] `NEXT_PUBLIC_BACKEND_URL` set on the Vercel project and redeployed —
      confirmed by grepping the shipped chunks for `onrender.com`, which the page
      itself cannot tell you. It was missing from the first build, and the
      symptom is worth recognising: every screen fetched `localhost:4000`, the
      visitor's own machine, which Chrome 138+ meets with an "Access other apps
      and services on this device" prompt and the app meets with "Can't reach the
      backend". `NEXT_PUBLIC_*` is inlined, so a redeploy is always part of the
      fix.
- [x] `CORS_ORIGIN` set to the Vercel origin instead of `*` — verified by
      preflight, the response echoes the origin rather than `*`.
- [ ] **Rotate the Gemini API key, then make the repo public** — in that order.
      The repo is currently PRIVATE, but a public GitHub repo is one of the five
      submission artifacts, so screeners would hit a 404. The key transited a
      chat; rotating after flipping visibility is rotating too late.
- [x] Confirm the deployed backend runs with `NODE_ENV=production` — `/health`
      reports `hostClass: "public"`, which is the only way to check it once the
      boot warning has scrolled away. It is the
      single host-class switch: it **caps** the payer faucet at 20 USDC and
      0.01 ETH per rolling 24h across all addresses (it does not close it —
      demo-account payments must still work for a judge), switches self-service
      onboarding OFF, and closes unauthenticated merchant-profile editing.
- [ ] **Confirm `NEXT_PUBLIC_DEMO_KEY` is set on the Vercel project.** Use a
      throwaway testnet key and know what you are shipping: it is inlined into
      the client bundle and shared by every visitor.
      Of the four build vars, three are confirmed from outside as of the 9 Aug build:
      `NEXT_PUBLIC_APP_URL` (the printable QR encodes the Vercel origin, not
      `localhost:3000`), `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (the
      `gantry-dev-placeholder` fallback is nowhere in the shipped chunks) and
      `NEXT_PUBLIC_BACKEND_URL` (the chunks carry `onrender.com`).
      **`NEXT_PUBLIC_DEMO_KEY` is the one left to confirm**, and only the Vercel
      dashboard can do it: its fallback is `undefined`, so it leaves no
      fingerprint to grep for the way the other three do. Miss it and the
      deployed payer page cannot take a payment at all.
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
  The Overview screen renders net **S$5.97** ("Collected, last 7 days") and
  **S$0.13** ("Saved vs cards") — the S$0.13 is the *saving*, not our cut. Never
  say "we took thirteen cents". The tiles were day-scoped until 10 Aug 2026 and
  now cover a rolling 7-day window; the demo figures are unchanged, because
  every payment in a run lands the same day.
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
- **Test counts are quoted on deck slide 8, so re-measure before quoting them.**
  As of 11 Aug 2026: **114 shared + 120 backend = 234 TypeScript tests**, plus 191
  Foundry of which **186 run in CI** — the 5 fork tests `vm.skip` without a fork
  RPC URL, so never cite them as something a screener can reproduce by cloning.
  The backend figure moves the most: it fell 137 → 119 when the agent-wallet
  scanner and the reset were deleted, so a count copied from an older section is
  wrong in the direction that overstates. They had drifted to "97 / 105 / 202"
  and nothing caught it, because
  the only place they appear is prose. `pnpm --filter @gantry/shared test` and
  `pnpm --filter @gantry/backend test` print the real numbers in one line each.
