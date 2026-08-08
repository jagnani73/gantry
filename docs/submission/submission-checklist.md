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
| 3 | Public GitHub repo with real commit history | live | continuous |
| 4 | Architecture diagram PNG (`architecture.md`) | mermaid source drafted | 10 Aug PM |
| 5 | Live dashboard URL (Vercel) + Basescan contract links | **not deployed yet** | 10 Aug |
| 6 | Team details + NTU proof of student status | **not requested yet** | ASAP |

## Still to do

- [ ] **Request the NTU enrolment certificate.** Longest lead time of anything
      on this list and entirely outside our control. Do this first.
- [ ] Deploy web to Vercel and backend to Railway/Fly (backend needs long-lived
      SSE, so serverless is out). **Config is written and committed** —
      `vercel.json` at the repo root and `packages/backend/Dockerfile` (build
      with the repo root as context). Neither has been run against a real host
      yet; the Dockerfile in particular is unbuilt, so budget time for a first
      build to fail on something small.
- [ ] Point `NEXT_PUBLIC_BACKEND_URL` at the deployed backend and set
      `CORS_ORIGIN` to the Vercel origin instead of `*`.
- [ ] On the public backend set `POLICY_ADMIN_ENABLED=0` — an open revoke lets
      any visitor zero the agent's policy and break the demo, and only the
      ADMIN_TOKEN can re-arm it.
- [ ] **Rotate the Gemini API key, then make the repo public** — in that order.
      The repo is currently PRIVATE, but a public GitHub repo is one of the five
      submission artifacts, so screeners would hit a 404. The key transited a
      chat; rotating after flipping visibility is rotating too late.
- [ ] Confirm the deployed backend runs with `NODE_ENV=production` — it is what
      disables the payer faucet, which otherwise hands real USDC out of the only
      gas key to anyone who asks.
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
  signs an EIP-3009 authorization against Circle's own contract, and burner
  wallets are funded by the relayer *transferring* real USDC — not minting.
  `MockXSGD` is the only mocked token, because XSGD exists on no testnet.
- **The demo prices are hawker-drink scale:** iced tea **S$1.50** (1.117652
  USDC), three iced teas **S$4.50** (3.352955 USDC), the rejected phone cable
  **S$4**. The old S$19.50 lunch / S$29 powerbank figures survive only as
  arithmetic fixtures in the test suites — never quote them.
- The fee story runs on the demo day's **S$6.00**: Gantry S$0.03, cards S$0.168.
  The dashboard strip renders net **S$5.97** and saved **S$0.13** — the S$0.13
  is the *saving*, not our cut. Never say "we took thirteen cents".
- Agent runs **Gemini** `gemini-flash-latest` via the Vercel AI SDK, not Claude.
- Live demo runs on **Base Sepolia over a hotspot**. Local Anvil was deferred
  and never built — don't describe it as a fallback we have.
- **GantrySwap does not exist.** `FixedRateSwap` ships behind the `IGantrySwap`
  interface, the rate is owner-set, and there is no AMM and no slippage.
- The agent door has **two** sub-paths: standard `exact` is custodial (one
  relayer hop), `gantry-pbm` is not.
- Contracts are named `GantryCore` and `AgentPBMWallet`. `SettlementRouter` and
  `PolicyGuard` appear in old planning notes and never existed in code.
