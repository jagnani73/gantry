# Slither triage

`slither-analyzer` 0.11.6 over `packages/contracts/src`, excluding `lib/`,
`node_modules/`, `test/` and `script/`.

**25 findings, all triaged below. Two High and three Medium, and every one of
them is the analyser reading a deliberate pattern as a defect.** That claim is
only worth anything if it can be checked, so each row says what was verified and
where, rather than asserting a verdict.

Run it:

```bash
cd packages/contracts && slither .          # reads slither.config.json
slither . --detect reentrancy-balance       # re-open one suppressed detector
```

## What CI runs, and what that does and does not buy

`slither.config.json` excludes the seven detectors below, so CI fails on
**anything else** at any severity. That is a regression gate over the detectors
we have not already answered — it is **not** a claim that these seven can never
fire on something real. A future reentrancy bug of the flagged shape would be
suppressed with them.

That trade is acceptable here for one specific reason: **the contracts are
frozen before the finals.** Nothing will change under these detectors between
now and then. If a contract changes afterwards, re-open the excluded detectors
with `--detect` and re-triage before trusting a green run.

## High

### `reentrancy-balance` ×2 — the balance-delta measurement

- `GantryCore.settleFromPBM` reads `balanceOf(this)` before
  `authorizeSpend(...)`, then compares `received < intent.amountIn`.
- `GantryCore._settle` reads `XSGD.balanceOf(this)` before `swap.swapExactIn(...)`,
  then compares `xsgdOut < intent.xsgdAmount`.

**Not reachable.** Measuring our own balance delta across the call is the point:
it is what makes the min-out guard independent of what the callee claims. The
finding would matter only if the callee could re-enter and move the balance
between the two reads.

Verified, not assumed:

- `GantryCore` does not inherit OpenZeppelin's `ReentrancyGuard`. It has a
  hand-rolled `nonReentrant` (`_lock` 1→2→1, `GantryCore.sol:159-164`) — which
  is why a reader looking only at the inheritance list would wrongly conclude
  there is no guard.
- `_settle` is `internal` with exactly two call sites, `GantryCore.sol:395` and
  `:419`.
- Both callers — `settleWithAuthorization` (`:381-396`) and `settleFromPBM`
  (`:405-420`) — carry `nonReentrant`.

So the external call cannot re-enter a settle path, and the delta it brackets
cannot be moved underneath it.

## Medium

### `incorrect-equality` ×2 — `_lastSpendDay == today`

`AgentPBMWallet.authorizeSpend:179` and `spentToday():253`.

**Correct as written.** The detector's concern is strict equality against a
value an attacker can step past. This one compares a **discrete day index**
(`block.timestamp / 1 days`), not a threshold: the counter belongs to today's
bucket or it does not. `>=` would be wrong — it would carry yesterday's spend
into today and under-report the remaining allowance.

The only way to miss the bucket is `_lastSpendDay > today`, i.e. time running
backwards, which no chain does. Covered by
`invariant_spentTodayNeverExceedsDailyCap` over day rollovers.

### `unused-return` ×1 — `swap.swapExactIn(...)`

`GantryCore._settle:496` discards the swap's return value.

**Deliberate, and the safer choice.** The return value is the swap's own account
of what it delivered. `_settle` instead measures the XSGD balance delta it
observed and enforces min-out against that, so a swap that lies — or is simply
wrong — cannot talk its way past the guard. Trusting the return value is the
version of this code that has a bug.

## Low

### `timestamp` ×5

`AgentPBMWallet.authorizeSpend`, `AgentPBMWallet.spentToday`,
`GantryCore.createIntent`, `GantryCore._beginSettle`, `EIP3009._checkAuthorization`.

**By specification.** EIP-3009 validity windows (`validAfter`/`validBefore`),
intent expiry and the policy expiry are all timestamp comparisons *because the
standards define them that way*. Already excluded from `forge lint` for the same
reason (`foundry.toml`, `exclude_lints = ["block-timestamp"]`); this keeps the
two analysers saying the same thing.

Miner timestamp drift is seconds. Intent TTL is 600s and `validBefore` is
expiry + 120s, so the drift is orders of magnitude inside the margin.

## Informational

- **`assembly` ×2** — `_splitSignature` in `AgentPBMWallet` and `EIP3009`. The
  standard 65-byte `(r, s, v)` split; the same code OpenZeppelin's ECDSA uses.
- **`naming-convention` ×7** — `DOMAIN_SEPARATOR()` is named by EIP-712 and
  cannot be renamed without breaking every client. `CORE`, `XSGD` are
  `immutable`, which this codebase spells in caps.
- **`unindexed-event-address` ×6** — admin events (`AgentSignerUpdated`,
  `RelayerUpdated`, `SwapUpdated`, `FeeUpdated`, `Rescued` ×2). Nothing indexes
  or filters on them: the indexer's `SWEPT_EVENTS` is six events and none of
  these is among them. Indexing costs gas on every settle-adjacent admin call to
  serve a query nobody makes.

## What this is not

Slither is a static analyser, not an audit. It found nothing it considered a
bug that survived reading, which is a statement about this tool's detectors and
not about the contracts being correct. The stronger evidence in this repo is the
201-test Foundry suite and the four policy invariants beside it.
