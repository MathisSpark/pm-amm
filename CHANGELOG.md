# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [sdk 0.3.0] — 2026-09-29

### Added (`@pm-amm/sdk`)
- `marketState(market, now?)` (`@pm-amm/sdk/math`): price, time left, resolution
  (`winner`), with reserves rescaled from `lastAccrualTs` to `now`. Pairing the
  stored reserves with today's `L_eff` over-promised swap output by +15–87% on
  devnet markets idle ~27 h (swaps accrue first), so tight `minOutput`s failed
  with `SlippageExceeded`.
- `quoteSwap(market, direction, amountIn, now?)`: exact quote in all 6
  directions (buys, sells, YES<->NO), 2% USDC-leg fee included. Matches
  `simulateTransaction` to < 0.01% on 6 live devnet markets. `minOutput(quote,
  slippageBps = 100)`.
- `client.fetchMarkets(pdas)`: many markets in one RPC call.
- `test/quote.cjs` (`pnpm run test:quote`): offline invariants for the above.

## [Unreleased] — Sprint 21 (multi-outcome + custom seed price)

### Added

- **EXTENSION**: Custom seed price for `initialize_market` via `initial_price_bps: u16`
  (range `[100, 9900]`; `0` keeps the legacy 50/50 default — backward-compatible).
  `pm_math::suggest_l_zero_at_price` calibrates `L_0` so `V(initial_price) == budget`.
- **EXTENSION**: Multi-outcome group markets — `GroupMarket` account composing N binary
  markets as legs of a categorical market. `MAX_LEGS = 32`. `total_seeded_bps: u32` tracks
  Σ p_i and is enforced ≤ 10_001 at every attach.
- 5 new Anchor instructions: `initialize_group_market`, `attach_leg_to_group`,
  `resolve_group`, `resolve_group_leg`, `cancel_group_market`.
- `Market::initial_price_bps` and `Market::group` fields (stored in the previously-reserved
  64-byte padding — `Market::LEN` unchanged at 443, no schema break).
- `resolve_market` now rejects attached legs (`LegMustCascadeResolve`), forcing cascade
  resolution through the group.
- `resolve_group_leg` has a defensive `winning_leg` bounds check (covers
  `NO_WINNING_LEG` sentinel + `< leg_count`).
- 11 new error codes for the full group lifecycle.
- `resolve_group::min_sum` formula uses `10_000 - leg_count - (10_000 % leg_count)` —
  proven by `test_group_resolve_min_sum_formula` to match the worst-case underseed
  for every N ∈ [2, MAX_LEGS].
- 22-test integration suite for the 5 group instructions
  (`anchor/tests/group_market.ts`), covering every reachable error code on localnet
  (overflow `> 10_001`, underseed worst case, cascade guard).
- 6-test access-control suite (`anchor/tests/access_control.ts`) for the binary
  instructions (accrue permissionless, signer-bound LpPosition, redeem_pair).
- `scripts/check_idl_coherence.py` — CI guard against IDL drift between the three
  bundled JSONs (`idl/`, `app/src/lib/`, `anchor/target/idl/`) and `state.rs`.
- `.github/workflows/integration.yml` runs `anchor test` on push to main + manual dispatch.
- `.github/workflows/test.yml` gains an `idl-coherence` job.
- `app/src/lib/program.ts` — typed read-only IDL wrapper with `idl.address` override
  from env-driven `PROGRAM_ID` (the JSON ships with the keypair's pubkey; the override
  lets the same JSON serve devnet and mainnet).
- New frontend pages: `/create-group` and `/group/[id]` (multi-line chart with Σ p_i
  indicator).
- New frontend hooks/libs: `useGroups`, `create-group`, `resolve-group`,
  `claim-group-winnings`.
- Random 48-bit market/group IDs in `create-group.ts` (front-running mitigation).
- Hardened `safeBalance` in `claim-group-winnings.ts`: distinguishes missing ATA from
  RPC errors (re-throws the latter).
- BigInt-split `i80f48ToNumber` for precision on Q64.64 values above 2^53.
- `doc/sprints/sprint-21-multi-outcome.md` documenting the port + what's deferred.

### Schema change (byte-compatible)

- `Market`: 64 bytes of padding → 2 bytes `initial_price_bps` + 32 bytes `group` +
  30 bytes padding. Same `LEN = 443`. Old accounts decode with `initial_price_bps = 0`
  (legacy 50/50) and `group = Pubkey::default()` (standalone) — backward-compatible.
- New `GroupMarket` account: 1188 bytes, fits well under the 10 240-byte init limit.
- All three bundled IDL JSON files re-synced. Integrators pinning either file must
  pull the new version after upgrading.

### Tested

- Smoke-tested end-to-end on devnet program `Dxf1PDY1sQjy3qEkekiV26rDv3W6GdkQSKx6hLLf13nK`:
  binary market with custom seed (60/40), 4-leg group market, swap, expiration, resolve,
  cascade, claim. All flows green through the UI.
- 60 Rust unit + 46 TS integration tests passing.

### Deferred

- Adapt leg seeding to `mint_pair + swap_yes_no` once Matt publishes the Sprint 20 Rust source.
- Off-chain dispatcher (Vyber pattern) for atomic inter-leg Σ p_i rebalancing between trades.
- `detach_leg_from_group` instruction — `market.group` stays write-once for now
  (documented inline in `state.rs::Market::group`).
- Full lifecycle integration tests on devnet (clock-warp).

## [0.1.0] - 2026-04-22

### Added

- 10 Anchor instructions: initialize_market, deposit_liquidity, swap, withdraw_liquidity, accrue, claim_lp_residuals, redeem_pair, resolve_market, claim_winnings, suggest_l_zero
- dC_t mechanism for continuous LP yield via per-share accumulators
- Fixed-point math (I80F48) with 2048-point lookup tables for on-chain performance
- Next.js frontend with trading, LP, portfolio, and admin panels
- Metaplex token metadata for YES/NO mints (name + symbol on-chain)
- 197 tests: 49 Rust unit, 18 TypeScript integration, 130 Python oracle
- Python reference oracle with scipy cross-validation
- Price history via Upstash Redis
- Mock USDC faucet for devnet testing
