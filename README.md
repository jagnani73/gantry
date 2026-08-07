# Gantry

**One rail, every payer: QR for humans, x402 for AI agents.**

Every payment system ever built assumes the payer is a human. Gantry is a payment rail on stablecoins where a merchant integrates once and gets paid by anyone — a person scanning a printed QR code, or an AI agent paying over the [x402 protocol](https://github.com/x402-foundation/x402). Both are encodings of the same on-chain `PaymentIntent`, both settle through the same contract, and the merchant always receives XSGD (Singapore-dollar stablecoin) — whatever token the payer sent.

Built for [NTU InnovateX Hackathon 2026](https://ntu-cctf-snz-innovatex-2026.devpost.com/) — Track 1: Payments & Financial Infrastructure.

## The idea in three lines

1. A payment is an **intent**: "merchant M requests S$X."
2. A QR code and an HTTP `402 Payment Required` response are just **two encodings of the same intent**.
3. One settlement contract consumes both — atomically swapping whatever stablecoin arrived into XSGD — so a hawker and an API get paid the same way by tourists and by software.

## Why Singapore

- PayNow is excellent — for payers with a Singapore bank account. The ~16M tourists who land at Changi each year have none; they fall back to cards (~2–3% merchant fees) or cash.
- AI agents can't open bank accounts at all. Since April 2026, x402 (Linux Foundation) gives them a standard way to pay — Gantry gives them somewhere to spend.
- Agent spending runs inside on-chain allowances — daily caps, merchant-category allowlists, expiry — [MAS Project Orchid's Purpose-Bound Money](https://www.mas.gov.sg/schemes-and-initiatives/project-orchid) idea, applied to AI agents.

## Status

🚧 **In development** for Stage 1 submission (14 Aug 2026).

- [x] `GantryCore` — merchant registry + PaymentIntent + dual-door settlement ([verified on Base Sepolia](https://sepolia.basescan.org/address/0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0))
- [x] Human door — printed QR → mobile payer page → gasless EIP-3009 payment
- [x] Agent door — x402 v2 endpoint + self-hosted facilitator (`exact` via the bridge AND the non-custodial `gantry-pbm` scheme; unmodified `@x402/fetch` still pays end-to-end)
- [x] `AgentPBMWallet` — on-chain Purpose-Bound-Money spend policies for agents ([verified on Base Sepolia](https://sepolia.basescan.org/address/0xDD4bbed78B64715288bf10fabB2b62c659299D3E))
- [x] Any-stablecoin-in → XSGD-out atomic FX, behind the `IGantrySwap` seam — shipping on `FixedRateSwap` (owner-set rate). A `GantrySwap` AMM was **deferred by decision (7 Aug 2026)**: a self-seeded toy pool is no closer to real FX than a fixed rate, and the interface is what makes the production path (real XSGD liquidity via aggregator/RFQ) a swap-in.
- [x] Merchant dashboard — live SSE feed with Human/Agent badges, agent policy panel with on-chain revoke, one feed for both doors
- [x] LLM-powered agent CLI (Gemini via the Vercel AI SDK) paying — and getting rejected on-chain — autonomously, with a visually-identical scripted fallback

### Deployed (Base Sepolia, `eip155:84532`)

| Contract | Address |
|---|---|
| [`GantryCore`](https://sepolia.basescan.org/address/0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0) | `0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0` |
| [`FixedRateSwap`](https://sepolia.basescan.org/address/0xEdcD7AcABb610543e1626F4453c9c4Ec8ABab713) | `0xEdcD7AcABb610543e1626F4453c9c4Ec8ABab713` |
| [`MockUSDC`](https://sepolia.basescan.org/address/0x5F7F058F2B1572524d1E3E740656CfAd1Ab011F9) | `0x5F7F058F2B1572524d1E3E740656CfAd1Ab011F9` |
| [`MockXSGD`](https://sepolia.basescan.org/address/0xd583FaB0Db5c543f5574780f8b899AEb74463361) | `0xd583FaB0Db5c543f5574780f8b899AEb74463361` |
| [`AgentPBMWalletFactory`](https://sepolia.basescan.org/address/0x172905F26F09b41636854338360315971240c1cf) | `0x172905F26F09b41636854338360315971240c1cf` |
| [`AgentPBMWallet` (demo)](https://sepolia.basescan.org/address/0xDD4bbed78B64715288bf10fabB2b62c659299D3E) | `0xDD4bbed78B64715288bf10fabB2b62c659299D3E` |

Primary pay token is Circle's testnet USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) — settlement is fork-tested against it. Demo merchants `ah-hock-chicken-rice` (food & beverage) and `gadgethub-sg` (electronics — the rejection beat) are registered on-chain.

## Layout

```
packages/contracts   Foundry — GantryCore, AgentPBMWallet + factory, FixedRateSwap (IGantrySwap), mocks
packages/shared      ABIs (generated via `pnpm abis`), addresses, quote math, EIP-712 typed data, API types
apps/backend         Express — merchant API, relayer, SSE indexer, x402 facilitator (exact + gantry-pbm) + protected order route
apps/web             Next.js — payer page /pay/[handle], printable QR /qr/[handle], dashboard + policy panel
apps/agent           LLM agent CLI (Vercel AI SDK + Gemini) with scripted fallback (pnpm --filter @gantry/agent start "…")
```

## Running locally

```bash
pnpm install
cp apps/backend/.env.example apps/backend/.env   # fill: RPC URL, relayer key, admin token
cp apps/web/.env.example apps/web/.env.local     # point NEXT_PUBLIC_* at your laptop's LAN IP
pnpm dev                                         # backend :4000 + web :3000 (binds 0.0.0.0)
```

- **Phone demo:** put the phone on the same Wi-Fi, set `NEXT_PUBLIC_APP_URL`/`NEXT_PUBLIC_BACKEND_URL` to `http://<laptop-LAN-IP>:<port>`, open `/qr/ah-hock-chicken-rice`, scan, pay. `?burner=1` (or `NEXT_PUBLIC_BURNER=1`) uses an in-browser demo wallet — auto-funded by the backend faucet, zero wallet setup.
- **CLI smoke test:** `pnpm --filter @gantry/backend e2e:pay` (quote → EIP-3009 sign → settle → replay-rejection check).
- **Agent-door interop proof:** `pnpm --filter @gantry/backend x402:buy` — pays the 402-protected order endpoint with the unmodified vanilla `@x402/fetch` client and prints the decoded challenge + on-chain receipt.
- **Reset between rehearsals:** `pnpm demo:reset` — clears the dashboard cache and prints addresses + demo URLs (<1s; chain state is reused).
- Verify with `pnpm lint`, `pnpm typecheck`, `pnpm test:contracts`, `pnpm --filter @gantry/shared test`.

## Tech

Solidity ^0.8.24 (Foundry) · Base Sepolia (`eip155:84532`) · x402 v2 (`@x402/*`) · EIP-3009 gasless authorizations · viem/wagmi · Next.js 15 · Node 22 + Express · Vercel AI SDK + Gemini (agent tool loop)

## Honest notes

Everything that matters here runs for real: the contracts are deployed and verified on Base Sepolia, the x402 traffic is spec-shaped v2 that an unmodified `@x402/fetch` client pays, the EIP-3009 authorizations are checked against Circle's real testnet USDC, and the agent's policy denials are contract reverts — not backend `if` statements.

What is not real, and why:

- **`MockXSGD`.** XSGD exists on no testnet (and not on Base), so testnet runs use a clearly-labeled mock. The mainnet path is real [XSGD](https://www.straitsx.com/) on a supported chain.
- **The FX rate is owner-set**, not market-derived — `FixedRateSwap` behind the `IGantrySwap` interface. Production means real XSGD liquidity through an aggregator or RFQ behind that same interface; the seam is the part that's meant to survive.
- **One trusted relayer/facilitator key.** It pays all gas, and on the vanilla-x402 `exact` path it briefly custodies the agent's funds (one hop, PSP-style) because spec-compliant clients generate their own EIP-3009 nonce. The `gantry-pbm` path has no such hop. Merchant registration is relayer-paid too — permissionless on-chain, so it's faucet trust level.
- **Merchant categories are self-attested.** No KYC, and no fiat off-ramp.

This is a hackathon prototype — production would operate with a licensed PSP under Singapore's Payment Services Act.

## Team

Yashvardhan Jagnani ([@jagnani73](https://github.com/jagnani73)) — NTU
