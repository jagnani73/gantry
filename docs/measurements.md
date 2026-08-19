# Measurements

What a Gantry payment costs and how long it takes, measured rather than
estimated. Every figure here is either a receipt on Base Sepolia or a Foundry
gas report; nothing is projected, and the sample sizes are small and stated.

Measured **17–19 Aug 2026** against `GantryCore`
`0xE6289ceA9232af61d7e4F30A67a848c0C322cc93`.

## Gas, from real transactions

Receipts fetched with `eth_getTransactionReceipt`, not from a test harness.

| Path | n | gas (min–max) | logs | example |
|---|---|---|---|---|
| Human QR — `settleWithAuthorization` | 2 | 183,666 – 183,676 | 10 | [`0x15a944…`](https://sepolia.basescan.org/tx/0x15a94489bd45309fb420ca5cbfd6e02f5526e08fe899d583f1ffbbfa5578e98d) |
| x402 `exact` via the bridge — settle leg | 1 | 181,676 | 10 | [`0x517080…`](https://sepolia.basescan.org/tx/0x5170803d0c28f928563eb22b4ef7be78785bceded22cd6421f9426abf7a0c350) |
| Agent PBM — `settleFromPBM` | 3 | 181,582 – 181,592 | 10 | [`0xbe8f39…`](https://sepolia.basescan.org/tx/0xbe8f39a8553869122388e27b6a9837fc431c8f6c5de850a327d815409dc8fbe5) |

**The three doors cost within ~1% of each other**, which is the convergence
claim showing up in the gas: they run the same `_settle`, and the spread is the
calldata and the authorization check in front of it.

**The bridge row is the settle leg only.** The `exact` path is two transactions,
and quoting 181,676 as "what an x402 payment costs" understates it:

| Leg | gas | tx |
|---|---|---|
| collect (`transferWithAuthorization` onto the relayer) | 85,740 | [`0x7e8adf…`](https://sepolia.basescan.org/tx/0x7e8adf0976cef1661f9a4391e7703afb92460d305c0219801bcc41fb6f20f36c) |
| settle | 181,676 | above |
| **total** | **267,416** | |

**So the custodial hop costs ~47% more gas than the direct PBM path**
(267,416 vs 181,582). That is the price of accepting a literally unmodified
`@x402/fetch` client — which cannot pin the EIP-3009 nonce to the intent — and
it is worth stating as a number rather than only as a caveat.

### The compensation path has a measured cost too

When a settle fails after the collect has landed, the bridge refunds. That path
is not theoretical here — it fired during the 7702 incident on 17 Aug:

| Event | gas | tx |
|---|---|---|
| refund to the payer after a failed settle | 45,059 | [`0x07d1bf…`](https://sepolia.basescan.org/tx/0x07d1bf806e70fc7c0806ae1613948165db15707fb135c786ca13e7790001f983) |
| EIP-7702 delegation revocation on the relayer | 36,800 | [`0xe637ce…`](https://sepolia.basescan.org/tx/0xe637cec4ad378d5e614c5b766713a58f07b516fef0cedbdbaf25210e24bcf49f) |

The refund is real evidence for a claim that is otherwise only asserted: money
collected for a settlement that never landed came back without anyone
intervening.

At the 0.006 gwei observed on Base Sepolia, **six settlements cost 0.0000066
ETH in total** — about 1.1 microether each. Base's fee market is not Ethereum's
and this should not be read as a mainnet estimate.

## Paying in euros costs the same as paying in dollars

The rail claims any currency in, Singapore dollars out. In gas that claim is
falsifiable, because both currencies run the same `_settle` with a different
`tokenIn` — so if euros were meaningfully dearer, the "same door" story would be
softer than it sounds.

| Path | USDC | EURC | difference |
|---|---|---|---|
| Human QR — `settleWithAuthorization` | 183,666 – 183,676 | [183,692](https://sepolia.basescan.org/tx/0x2ef7f5643891dbbac87c1eb85791144f64b14ae6c2e60d8ddd66acbe9f81d0d0) | +21 vs midpoint |
| Agent PBM — `settleFromPBM` | 181,582 – 181,592 | [181,582](https://sepolia.basescan.org/tx/0x0013298126ebea3136db415559bf43299ec9f78dbac16ea25a48dbf837536f7f) | 0 |
| x402 `exact` — settle leg | 181,676 | [181,676](https://sepolia.basescan.org/tx/0x26db556614fef6ea9f2d91a809c77a2bae26cf955d6821b8a668965e51e130c3) | 0 |
| x402 `exact` — collect leg | 85,740 | [85,732](https://sepolia.basescan.org/tx/0xc3b4320394daa6c2ff8fa777abeb77415fa5afdaf939e3059721c9a52b8a5df0) | −8 |
| x402 `exact` — **total** | **267,416** | **267,408** | **−8** |

**Currency is free to within single-digit gas on every door.** Circle's EURC and
USDC are both FiatToken v2 with a byte-identical `TRANSFER_WITH_AUTHORIZATION`
typehash, so there is no second code path for the EVM to price differently.

**One measurement contradicts that and is worth keeping rather than dropping.**
The FIRST euro payment ever made on this rail
([`0x0d2c5eaf…`](https://sepolia.basescan.org/tx/0x0d2c5eaf7b5a6010ad03b28155b80fb814967c674583601d48f9cac0824b373f),
19 Aug) cost **197,356** — about 7% more than its dollar equivalent, which would
be a real euro tax if it held. It does not: the same door, same amount and same
token measured **183,692** once repeated. The 13,664 difference is cold storage —
slots the contracts had never touched for a token they had never handled — and
the way to know that is that it happened once and never again, not that the
number looks like an SSTORE.

The lesson generalises past this table: **the first transaction against a newly
listed token is not a sample of what that token costs.**

## Gas, from the Foundry suite

`forge test --gas-report`, 201 tests. Deterministic, so these are the numbers
that move when the contracts change.

| Contract | Function | min | avg | max | calls |
|---|---|---|---|---|---|
| GantryCore | `settleWithAuthorization` | 30,575 | 122,867 | 212,196 | 29 |
| GantryCore | `settleFromPBM` | 30,356 | 112,729 | 191,708 | 26 |
| GantryCore | `createIntent` | 25,412 | 111,613 | 120,857 | 74 |
| GantryCore | `registerMerchant` | 24,270 | 46,799 | 976,511 | 369 |
| GantryCore | `setMerchantPayout` | 22,183 | 25,216 | 29,226 | 4 |
| AgentPBMWallet | `authorizeSpend` | 24,420 | 55,661 | 81,651 | 6,099 |
| AgentPBMWallet | `setPolicy` | 24,206 | 64,715 | 115,315 | 5,991 |
| AgentPBMWallet | `revoke` | 23,498 | 36,244 | 38,231 | 4,674 |
| AgentPBMWalletFactory | `createWallet` | 105,067 | 1,064,105 | 1,202,897 | 18 |
| FixedRateSwap | `swapExactIn` | 24,929 | 94,151 | 95,538 | 264 |

**The call counts moved a lot since 18 Aug and the contracts did not.**
`authorizeSpend` went 1,595 → 6,099, `setPolicy` 1,111 → 5,991 and `revoke`
6 → 4,674, because the invariant handler was fixed: `rearm` now always arms a
policy that admits something, and `revokeNow` is a fuzz target, so far more of
the campaign reaches a real spend instead of bouncing off a dud policy. The
per-call gas figures are unchanged; only how often each is exercised is.

**Read the `min` column as revert cost, not as a cheap happy path.** Every
number near 24k is a policy refusal or a validation revert — the suite tests
refusals heavily, and `authorizeSpend`'s 1,595 calls are mostly the invariant
campaign hammering caps and categories. The happy path is the `max` column.

`registerMerchant`'s 976,511 max is a first-write to a cold merchant slot with
full profile strings; its median is ~25k because most of those 363 calls are
reverts.

## Latency

Wall-clock for `pnpm --filter @gantry/backend e2e:pay`, which covers the whole
human door: faucet top-up, intent creation, EIP-3009 signing, settle, and
receipt. One observation is not a distribution — see the caveat below.

| Run | Wall clock | Block |
|---|---|---|
| 1 | 5.09 s | 45607404 |
| 2 | 5.47 s | 45607442 |
| 3 | 5.61 s | 45607479 |
| 4 | 4.62 s | 45607517 |
| 5 | 3.46 s | 45607554 |

**n=5 · min 3.46 s · median 5.09 s · mean 4.85 s · max 5.61 s.**

Five observations is a sample, not a distribution — quote the range, not the
mean alone. The spread is roughly one Base Sepolia block either way, which is
what you would expect when a receipt wait dominates.

**The 60s faucet cooldown shapes how this can be measured at all.** Repeat runs
against one payer return `429 FaucetCooldown`, so a tight loop measures the
cooldown rather than the rail — the first attempt at this produced one good run
followed by two 1.1 s failures. These runs are spaced 70 s apart against a
single payer; the alternative is a fresh payer per run, which costs 4 USDC of
real Circle testnet USDC each time.

**The agent door is deliberately not timed here.** It runs the same `_settle`
(the gas figures above differ by under 1%), and the extra wall-clock is LLM
narration — a property of whichever model is behind `AISA_MODEL` or
`GOOGLE_GENERATIVE_AI_API_KEY`, not of the rail. Timing it would measure the
provider.

Base Sepolia targets ~2s blocks, so a settle that includes a receipt wait cannot
beat one block, and the demo script's "under two seconds" refers to the row
landing on the dashboard over SSE — which is the indexer's latency, not this.

## What is not measured here

- **Mainnet cost.** Everything above is Base Sepolia.
- **The bridge's collect leg**, as noted.
- **Cold-start latency** on the deployed Render instance, which spins down after
  15 minutes idle and takes ~50s to wake. The keepalive pinger exists to make
  that not happen; it is not measured here.
- **The indexer's SSE latency** — the number the demo actually shows.

## Reproducing

```bash
forge test --root packages/contracts --gas-report        # the deterministic table
forge test --root packages/contracts                     # …and the suite's actual pass/fail
pnpm --filter @gantry/backend e2e:pay                    # one human-door payment, timed by wall clock
pnpm --filter @gantry/backend e2e:pay -- --token EURC    # the same door, in euros
```

**`--gas-report` makes one test fail, and the suite is green without it.**
`test_registerMerchant_isSingleCheapTx` asserts onboarding stays under 200,000
gas; it measures **180,649 on a plain run and 204,923 under the reporter**, so
following the first command above produces `1 failed` and a red exit code. The
reporter instruments every call and that overhead lands inside the `gasleft()`
delta the test takes, which is a property of the measurement and not of the
contract. Verified deterministic — 208,604 reported, twice, and 180,649 plain.

So: **read the table from the `--gas-report` run and the verdict from the plain
one.** Anyone grading the suite by the command in this file alone would conclude
`registerMerchant` had regressed by 24k when nothing had changed.

Receipts were read straight from `https://sepolia.base.org` with
`eth_getTransactionReceipt`. Note that node **403s a default urllib
user-agent**, so a Python script fetching them needs a browser UA or should
shell out to `curl`.
