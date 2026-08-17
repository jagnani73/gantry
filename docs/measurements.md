# Measurements

What a Gantry payment costs and how long it takes, measured rather than
estimated. Every figure here is either a receipt on Base Sepolia or a Foundry
gas report; nothing is projected, and the sample sizes are small and stated.

Measured **17–18 Aug 2026** against `GantryCore`
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

## Gas, from the Foundry suite

`forge test --gas-report`, 195 tests. Deterministic, so these are the numbers
that move when the contracts change.

| Contract | Function | min | avg | max | calls |
|---|---|---|---|---|---|
| GantryCore | `settleWithAuthorization` | 30,575 | 115,305 | 212,196 | 22 |
| GantryCore | `settleFromPBM` | 30,356 | 112,729 | 191,708 | 26 |
| GantryCore | `createIntent` | 25,412 | 111,053 | 120,857 | 68 |
| GantryCore | `registerMerchant` | 24,270 | 46,836 | 976,511 | 363 |
| GantryCore | `setMerchantPayout` | 22,183 | 25,216 | 29,226 | 4 |
| AgentPBMWallet | `authorizeSpend` | 24,420 | 66,583 | 81,651 | 1,595 |
| AgentPBMWallet | `setPolicy` | 24,206 | 43,742 | 115,315 | 1,111 |
| AgentPBMWallet | `revoke` | 23,498 | 33,510 | 37,305 | 6 |
| AgentPBMWalletFactory | `createWallet` | 105,067 | 1,064,105 | 1,202,897 | 18 |
| FixedRateSwap | `swapExactIn` | 24,929 | 94,151 | 95,538 | 264 |

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
pnpm --filter @gantry/backend e2e:pay                    # one human-door payment, timed by wall clock
```

Receipts were read straight from `https://sepolia.base.org` with
`eth_getTransactionReceipt`. Note that node **403s a default urllib
user-agent**, so a Python script fetching them needs a browser UA or should
shell out to `curl`.
