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
      SSE, so serverless is out).
- [ ] On the public backend set `POLICY_ADMIN_ENABLED=0` — an open revoke lets
      any visitor zero the agent's policy and break the demo, and only the
      ADMIN_TOKEN can re-arm it.
- [ ] Export the mermaid diagram to PNG and check it reads at thumbnail size.
- [ ] Print slide 1 and confirm the QR scans off a projected image, not just
      off a screen.
- [ ] Add a CI badge (`forge test`) to the README.
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

- Agent runs **Gemini** `gemini-flash-latest` via the Vercel AI SDK, not Claude.
- Live demo runs on **Base Sepolia over a hotspot**. Local Anvil was deferred
  and never built — don't describe it as a fallback we have.
- **GantrySwap does not exist.** `FixedRateSwap` ships behind the `IGantrySwap`
  interface, the rate is owner-set, and there is no AMM and no slippage.
- The agent door has **two** sub-paths: standard `exact` is custodial (one
  relayer hop), `gantry-pbm` is not.
- Contracts are named `GantryCore` and `AgentPBMWallet`. `SettlementRouter` and
  `PolicyGuard` appear in old planning notes and never existed in code.
