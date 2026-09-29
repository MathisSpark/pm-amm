# pm-AMM — Full API Reference

A deep, per-function reference for the pm-AMM program and the `@pm-amm/sdk`.
This complements the quickstart in [`packages/sdk/README.md`](../packages/sdk/README.md)
(get-started-in-5-minutes) — here every on-chain instruction and every SDK
function is documented individually.

- **Program (devnet):** `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`
- **Mock USDC (devnet):** `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ` (6 decimals)
- **Math source of truth:** [`doc/wp-para.md`](./wp-para.md) (Paradigm pm-AMM, Moallemi & Robinson 2024)

---

## 1. Mental model

### Layers
```
your app ──► @pm-amm/sdk ──► Anchor program (26 instructions) ──► Solana
             client.send.*     (this is where the money/rules live)
             client.ix.*
             client.flows.*
             client.fetch*
             math.*  (pure, no chain)
```
- **`client.send.*`** — build + sign + send a full transaction (adds the compute-budget ix and creates missing ATAs). The 90% path.
- **`client.ix.*`** — return a raw `TransactionInstruction` so you compose your own transaction.
- **`client.flows.*`** — multi-instruction orchestrations (e.g. create a whole group market).
- **`client.fetch*`** — typed account reads.
- **`math.*`** — pure TypeScript ports of the paper's formulas (no RPC, importable from `@pm-amm/sdk/math`).

### The five market types
1. **Binary market** — one YES/NO market (`initialize_market`).
2. **Binary, custom seed** — same, seeded at any price via `initial_price_bps`.
3. **Multi-outcome group** — N binary markets wrapped as legs of a categorical market (`GroupMarket`).
4. **Binary commitment vault** — crowd commits USDC, then the market launches bootstrapped by that liquidity.
5. **Multi-outcome commitment vault** — same, for an N-leg categorical market.

### The dynamic pm-AMM in one paragraph
Liquidity decays as `L_eff = L_0 · sqrt(T − t)`, which makes the LP's loss-versus-rebalancing (LVR) **uniform in time**. As `L_eff` shrinks, reserves are continuously released to LPs through the **`dC_t` accrual** mechanism (per-share accumulators `cum_yes_per_share` / `cum_no_per_share`). Reserves `x` (YES) and `y` (NO) are **virtual** curve counters; real YES/NO SPL tokens are only minted to users on swap / withdraw / residual-claim.

### Collateralization & fees (read this)
- **Solvency (post audit #1):** the first deposit calibrates `L_0` so that **`max(x, y) = deposit`** (`suggest_l_zero_for_max_reserve`), and `swap` hard-reverts any trade that would leave `vault < max(yes_supply + reserve_yes, no_supply + reserve_no)`. So the winning side is **always** redeemable 1 USDC each — `claim_winnings` can never be locked out. The trade-off: a market seeded far from 50/50 needs proportionally more USDC backing (less depth per dollar) — the inherent, correct cost of solvency.
- **Fees: a 2% protocol fee on the USDC leg of a swap** (`SWAP_FEE_BPS = 200`), split **50% to the protocol DAO** (`4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph`) and **50% to the market creator** (`market.authority`). On a BUY (USDC→YES/NO) the fee is skimmed off the input (only the net backs the vault); on a SELL (YES/NO→USDC) it is skimmed off the curve output. **Pure YES↔NO swaps are fee-free.** `redeem_pair` is exactly 1:1:1 and `claim_winnings` pays exactly 1 USDC per winning token (no fee). When the swapper IS the creator, `creator_usdc` is omitted (passed as `null`) so they simply keep their half — this also avoids a duplicate-mutable-account error with `user_collateral`. The fee does **not** accrue to LPs; their economics remain the curve spread (slippage) + the `dC_t`/LVR dynamics. The solvency guard (above) still holds because it is checked post-trade against the actual vault balance.

### PDAs (all derived from the program id)
| Account | Seeds |
|---|---|
| `Market` | `["market", market_id_le_u64]` |
| `LpPosition` | `["lp", market, owner]` |
| `GroupMarket` | `["group", group_id_le_u64]` |
| YES / NO mint | `["yes_mint" / "no_mint", market]` |
| Market USDC vault | `["vault", market]` |
| `CommitmentVault` | `["vault", vault_id_le_u64]` |
| Vault collateral ATA | `["vault_collateral", vault]` |
| `CommitPosition` | `["commit", vault, owner]` |
| `CommitmentVaultGroup` | `["vault_group", vault_id_le_u64]` |
| Vault-group collateral | `["vault_group_collateral", vault]` |
| `CommitPositionGroup` | `["commit_group", vault, owner]` |

The SDK exposes pure derivations: `derive*(programId, …)` (see §7), plus `client.lpPosition(market, owner)`, `client.yesMint(market)`, `client.noMint(market)`, `client.marketVault(market)`.

---

## 2. Client setup

```ts
import { PmAmmClient } from "@pm-amm/sdk";
import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAM = new PublicKey("GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y");
const USDC    = new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ");
```

### `PmAmmClient.readOnly(connection, programId, collateralMint, opts?)`
Reads + instruction-building only (no signing). Use for indexers, previews, server reads.

### `PmAmmClient.fromProvider(provider, programId, collateralMint, opts?)`
Full client. `provider` is an `AnchorProvider` (wallet + connection). Enables `client.send.*`.
`opts.metaplexProgramId` overrides the Token-Metadata program (defaults to the mainnet/devnet Metaplex id).

Both build the `Program` once with the address overridden to `programId`, so a single SDK build works against any deployment.

---

## 3. On-chain instructions (26 + 8 bet vault)

> The 8 Bet Vault v2 instructions (Sprint 25: `initialize_bet_vault`, `bet_commit`, `launch_bet_vault`, `resolve_bet_vault`, `settle_bet_vault`, `void_bet_vault`, `claim_bet`, `refund_bet`) are specified in [`bet-vault-v2.md`](bet-vault-v2.md); their SDK surface is in `packages/sdk/llms.txt`.

Notation: `(s)` = signer, `(w)` = writable. Only the decision-relevant accounts are listed; the SDK derives the rest. Each entry ends with the SDK call that wraps it.

### 3.1 Binary market (10)

#### `initialize_market(market_id: u64, end_ts: i64, name: string, initial_price_bps: u16)`
Create a market: the `Market` PDA, YES + NO mints, the USDC vault, and Metaplex metadata for wallet display.
- **Authority:** `authority(s)` becomes `market.authority` (the only key that can later `resolve_market`).
- **`initial_price_bps`:** seed price in bps. `0` = legacy 50/50; otherwise `[100, 9900]`. For a group leg, `10_000 / N`.
- **Duration:** `end_ts` must be `[now + 300s, now + 50y]`.
- **Note:** creates the market *shell* with `l_zero = 0`; liquidity is added by the first `deposit_liquidity`.
- **SDK:** `client.send.createMarket({ name, endTs, initialPriceBps?, marketId? })` → `{ marketPda, marketId }`.

#### `deposit_liquidity(amount: u64)`
Add USDC liquidity; receive LP shares.
- **First deposit:** bootstraps `L_0` so **`max(x, y) = amount`** at `initial_price` (audit #1), sets `total_lp_shares = amount` (1 USDC = 1 share).
- **Follow-up:** preserves the current price, adds `L_eff` for `amount` at the worst-case side; `new_shares = amount`.
- Runs `accrue` first; pending residuals are preserved via a weighted checkpoint.
- **Accounts:** `signer(s)`, `market(w)`, `vault(w)`, `user_collateral(w)`, `lp_position(w, init_if_needed)`.
- **SDK:** `client.send.depositLiquidity(market, amountUsdc)`.

#### `swap(direction: SwapDirection, amount_in: u64, min_output: u64)`
Trade between USDC/YES/NO (6 directions: `UsdcToYes`, `UsdcToNo`, `YesToUsdc`, `NoToUsdc`, `YesToNo`, `NoToYes`).
- Mints/burns the user's YES/NO and moves USDC against the curve; updates reserves.
- **Guards:** `!resolved`, `time_remaining > 0`, `output ≥ min_output` (slippage), USDC-out needs `vault ≥ output`, **and the solvency guard** (audit #1): reverts if the post-trade `vault < max(yes_supply + reserve_yes, no_supply + reserve_no)`.
- **SDK:** `client.send.swap({ market, direction, amountIn, minOutput? })`.

#### `withdraw_liquidity(shares_to_burn: u128)`
Burn LP shares → receive proportional YES + NO (auto-claims pending residuals first). Rejected post-resolution (use `claim_lp_residuals` + `claim_winnings` then). Closes the `LpPosition` and refunds rent when shares reach 0. Pass the **raw `shares` bits** for an exact full withdraw.
- **SDK:** `client.send.withdrawLiquidity(market, sharesToBurn)` (BN of raw bits, or a number).

#### `accrue()`
Permissionless. Advances the `dC_t` accrual to now (releases reserves into the per-share accumulators as `L_eff` decays). No token movement. Every mutative instruction calls this internally first; you rarely call it directly.
- **SDK:** `client.send.accrue(market)`.

#### `claim_lp_residuals()`
Mint the caller's pending YES + NO residuals (`(cum − checkpoint) × shares`) and advance their checkpoint. Allowed any time, including post-resolution. The post-resolution LP path is: `claim_lp_residuals` → `claim_winnings`.
- **SDK:** `client.send.claimLpResiduals(market)`.

#### `redeem_pair(amount: u64)`
Burn `amount` YES + `amount` NO → receive `amount` USDC. Always valid (pre/post resolution); the complete-set escape hatch.
- **SDK:** `client.send.redeemPair(market, amountMicro)`.

#### `suggest_l_zero(budget_usdc: u64, sigma_bps: u64)`
View-only: emits an `LZeroSuggestion` event with the optimal `L_0` for a budget. Composable via CPI. (For UI previews use `math.simulateLpDeposit` instead.)
- **SDK:** `client.ix.buildSuggestLZero({ market, budgetUsdc, sigmaBps })`.

#### `resolve_market(winning_side: Side)`
Authority-only. After `end_ts`, set the winning side (runs a final accrual). Rejected for markets attached to a group (those cascade via `resolve_group_leg`).
- **Accounts:** `signer(s)` must equal `market.authority`.
- **SDK:** `client.send.resolveMarket(market, side)` (`side` = `{ yes: {} }` | `{ no: {} }`).

#### `claim_winnings(amount: u64)`
Post-resolution. Burns the caller's YES + NO and pays **1 USDC per winning-side token** (losing side burned for 0). The `amount` arg is currently ignored — it always settles the full balance. Double-claim is impossible (tokens are burned).
- **SDK:** `client.send.claimWinnings(market)`.

### 3.2 Multi-outcome group market (5)

#### `initialize_group_market(group_id: u64, end_ts: i64, name: string, leg_count: u8)`
Create a `GroupMarket` wrapping `leg_count` (2..=32) binary markets. Legs are attached afterwards.
- **SDK:** usually via the flow `client.flows.createGroup(...)`; raw builder `client.ix.buildInitializeGroupMarket(...)`.

#### `attach_leg_to_group(leg_index: u8)`
Bind an existing binary `Market` to a group slot. Enforces same authority, same `end_ts`, seed price `= 10_000/N` bps, and `total_seeded_bps ≤ 10_001` (Σ p_i ≤ 1.0001). **Write-once:** a market can only ever join one group.
- **Authority:** both `group.authority` and `market.authority` must equal `authority(s)`.

#### `resolve_group(winning_leg: u8)`
Authority-only. After `end_ts`, pick the winning leg. Requires all legs attached and `total_seeded_bps` above the worst-case underseed floor.

#### `resolve_group_leg(leg_index: u8)`
Permissionless cascade: once the group is resolved, finalize each leg (winning leg → `Yes`, others → `No`). The group's `winning_leg` is the single source of truth.
- **SDK:** the cascade + payout is wrapped by `client.flows.claimAllGroupWinnings(...)` / `findClaimableLegs(...)`.

#### `cancel_group_market()`
Authority-only. After `end_ts`, mark an abandoned group resolved with `NO_WINNING_LEG`, so every attached leg can finalize as `No` via `resolve_group_leg`.
- **SDK:** `client.flows.cancelGroup(...)`.

### 3.3 Binary commitment vault (5) — committers become LPs (audit #6)

#### `initialize_vault(vault_id, name, commit_duration_secs, market_duration_secs, min_total)`
Open a vault. Anyone may call. `commit_duration ≥ 60s`, `market_duration ≥ 300s`, `min_total > 0`.
- **SDK:** `client.send.createVault({ name, commitDurationSecs, marketDurationSecs, minTotalUsdc })`.

#### `vault_commit(side: Side, amount: u64)`
Commit USDC on YES or NO (min 1 USDC), any number of times, until `commit_end_ts`. The YES/NO split sets the **launch price**; your committed total becomes your **LP stake** (see `claim_committer`).
- **SDK:** `client.send.vaultCommit(vault, side, amountUsdc)`.

#### `launch_vault_market(market_id: u64)`
Permissionless, after `commit_end_ts` and `total ≥ min_total`. Creates the market **and deposits the whole committed pot as liquidity** — calibrates `L_0` so `max(x,y) = total` at the commit-ratio price, sets `total_lp_shares = total`, and moves the USDC `vault_collateral → market_vault`. The market opens fully collateralized.
- **SDK:** `client.send.launchVaultMarket(vault)` → `{ marketPda, marketId }`.

#### `claim_committer()`
Materialize the committer's **`LpPosition`** (1 USDC committed = 1 LP share, checkpoint = launch baseline so they earn `dC_t` residuals from launch). No YES/NO mint. Afterwards the committer is a normal LP (`claim_lp_residuals` / `withdraw_liquidity` / `claim_winnings`).
- **Accounts:** `signer(s)`, `vault`, `market`, `commit_position(w)`, `lp_position(w, init)`.
- **SDK:** `client.send.claimCommitter(vault, market)`.

#### `refund_commit()`
1:1 refund, available **only when the launch can no longer succeed** (audit #4): `total < min_total` OR the launch window has closed (`now + 300 ≥ market_end_ts`). This blocks the grief where a healthy vault is refunded below threshold to kill a legit launch.
- **SDK:** `client.send.refundCommit(vault)`.

### 3.4 Multi-outcome commitment vault (6)

#### `initialize_vault_group(vault_id, name, leg_names: Vec<string>, commit_duration_secs, market_duration_secs, min_total)`
Open an N-leg (2..=8) vault; authority sets the leg names.
- **SDK:** `client.send.createVaultGroup({ name, legNames, commitDurationSecs, marketDurationSecs, minTotalUsdc })`.

#### `vault_commit_group(leg_index: u8, amount: u64)`
Commit USDC on a specific leg until `commit_end_ts`.
- **SDK:** `client.send.vaultCommitGroup(vault, legIndex, amountUsdc)`.

#### `launch_vault_group_market(group_id: u64)`
Step 1 (permissionless): create the wrapping `GroupMarket`. Requires `total ≥ min_total` and every leg ≥ 100 bps share; else the launch is jailed and refund opens.
- **SDK:** `client.send.launchVaultGroupMarket(vault)` → `{ groupPda, groupId }`.

#### `launch_vault_group_leg(leg_index: u8, market_id: u64)`
Step 2 (run once per leg): create the leg's binary market + mints + vault + metadata, seeded at `leg_total/total` bps, and attach it to the group. Only requires the leg to be unexpired (audit #5 removed the per-leg 300s trap).
- **SDK:** `client.send.launchVaultGroupLeg(vault, group, legIndex)`.

#### `claim_committer_group(leg_index: u8)`
Per-leg claim (call once per committed leg): mint that leg's YES tokens 1:1 with the leg commit, and transfer the backing USDC from the vault to the leg's market vault. Zeroes `leg_amounts[leg]` to prevent re-claim.
- **SDK:** `client.send.claimCommitterGroup(vault, group, legMarket, legIndex)`.

#### `refund_commit_group()`
1:1 refund of unclaimed legs, available when the launch can no longer complete (audit #4 + #5): **pre-launch** (under min_total / a leg under floor / window closed) **or post-launch incomplete** (group initialized but not all legs launched by `market_end_ts`).
- **SDK:** `client.send.refundCommitGroup(vault)`.

---

## 4. SDK reads (`client.fetch*`)

All return a decoded, typed account or `null`. `fetchAll*` use a `dataSize` filter to skip stale layouts.

| Method | Returns |
|---|---|
| `fetchMarket(pda)` | `MarketAccount \| null` |
| `fetchAllMarkets(dataSize = 443)` | `{ publicKey, account }[]` |
| `fetchLpPosition(market, owner)` | `LpPositionAccount \| null` |
| `fetchGroup(pda)` / `fetchAllGroups()` | `GroupMarketAccount` |
| `fetchVault(pda)` / `fetchAllVaults()` | `CommitmentVaultAccount` |
| `fetchCommitPosition(vault, owner)` | `CommitPositionAccount \| null` |
| `fetchVaultGroup(pda)` / `fetchAllVaultGroups()` | `CommitmentVaultGroupAccount` |
| `fetchCommitGroupPosition(vault, owner)` | `CommitPositionGroupAccount \| null` |

Reserves/shares/accumulators are stored as **I80F48** (`u128` bits) — convert with `math.i80f48ToNumber(raw)`.

---

## 5. SDK writes — builders, send, flows

Every instruction has a builder `client.ix.build*` (returns `TransactionInstruction`) and, for the common ones, a `client.send.*` wrapper (builds + CU budget + ATA pre-ixs + sign + send). The 26 builders mirror §3 one-to-one (`buildInitializeMarket`, `buildSwap`, `buildClaimCommitter`, …).

### `client.send.*` (transaction wrappers)
```
createMarket(input)                       swap({market,direction,amountIn,minOutput?})
depositLiquidity(market, amountUsdc)      withdrawLiquidity(market, sharesToBurn)
redeemPair(market, amountMicro)           claimWinnings(market)
claimLpResiduals(market)                  resolveMarket(market, side)
accrue(market)
createVault(input)                        vaultCommit(vault, side, amountUsdc)
launchVaultMarket(vault)                  claimCommitter(vault, market)
refundCommit(vault)
createVaultGroup(input)                   vaultCommitGroup(vault, legIndex, amountUsdc)
launchVaultGroupMarket(vault)             launchVaultGroupLeg(vault, group, legIndex)
claimCommitterGroup(vault, group, market, legIndex)   refundCommitGroup(vault)
```
`swap` directions are `"UsdcToYes" | "UsdcToNo" | "YesToUsdc" | "NoToUsdc" | "YesToNo" | "NoToYes"`. `side` is `{ yes: {} } | { no: {} }`. Heavy ixs (launches, swap, withdraw) use a 1.4M compute-budget; others 400k.

### `client.flows.*` (orchestrations)
- **`createGroup({ human, name, endTs, legCount, … })`** → creates the `GroupMarket` + `legCount` binary markets (each seeded at `10_000/legCount` bps) + attaches them. Returns the group + leg PDAs.
- **`findClaimableLegs({ groupPda })`** → inspects a resolved group and returns the legs whose winnings the wallet can claim.
- **`claimAllGroupWinnings({ groupId, groupPda, legMarketIds })`** → cascades `resolve_group_leg` where needed and claims winnings across all legs.
- **`cancelGroup({ groupPda })`** → authority cancel + leg finalization as `No`.

---

## 6. Math (`@pm-amm/sdk/math`, pure)

Paper formulas, no RPC. Numbers are plain `number` (USDC in whole tokens unless noted).

| Function | Purpose |
|---|---|
| `phi(z)` | Standard normal PDF φ(z). |
| `capitalPhi(z)` | Standard normal CDF Φ(z). |
| `priceFromReserves(x, y, lEff)` | `P = Φ((y − x)/L_eff)`. |
| `poolValue(price, lEff)` | `V(P) = L_eff · φ(Φ⁻¹(P))`. |
| `estimateSwapOutput(...)` | Off-chain estimate of a swap's output (UI preview). |
| `simulateLpDeposit(amount, price, lEff, totalShares, remainingSecs, lZero)` | Preview LP shares + pool share + est. daily yield (mirrors the on-chain max-reserve calibration). |
| `lpPositionPnl(...)` | Mark-to-market P&L of an LP position. |
| `expectedDailyLvr(price, lEff, remainingSecs)` | Expected LVR/day (`V/(2·remaining)`). |
| `expectedTerminalWealth(deposited)` | `deposited / 2` (paper: `E[W_T] = W_0/2`). |
| `expectedLegSeedBps(legCount)` / `expectedLegSeedPrice(legCount)` | `10_000/N` bps and `1/N` price for a group leg. |
| `legBudgetAllocations(legCount, totalLamports)` | Split a budget evenly across legs. |
| `sumProbabilities(prices)` / `groupDriftPct(prices)` | Σ p_i and its drift from 1.0 (group coherence). |
| `expectedDriftAfterBet(...)` | Predicted Σ p_i drift after a bet on a leg. |
| `i80f48ToNumber(raw)` | Convert an on-chain Q64.64 (I80F48) value to a number. |
| `formatUsdc(lamports)` / `formatPrice(price)` / `formatTimeRemaining(endTs)` | Display helpers. |

---

## 7. PDAs, constants, errors

### PDA derivations (pure)
`deriveMarketPda(programId, marketId)`, `deriveLpPosition(programId, market, owner)`,
`deriveGroupPda(programId, groupId)`, `deriveYesMint` / `deriveNoMint(programId, market)`,
`deriveMarketVault(programId, market)`, `deriveVaultPda` / `deriveVaultCollateralPda(programId, …)`,
`deriveCommitPositionPda(programId, vault, owner)`, and the vault-group equivalents,
`deriveMetadataPda(mint, metaplexProgramId)`.

### Constants & helpers
`METAPLEX_PROGRAM_ID`, `CU = { DEFAULT: 400_000, HEAVY: 1_400_000 }`, `SEEDS`,
`solscanTxUrl(sig)`, `solscanAccountUrl(addr)`, plus `mapAnchorError(err)` to turn a raw Anchor error into a typed `PmAmmError`.

### Selected errors
`InvalidPrice`, `InvalidDuration`, `InsufficientLiquidity`, `InsufficientOutput`, `SlippageExceeded`, `InsufficientVault`, `MarketAlreadyResolved`, `MarketNotExpired`, `LegMustCascadeResolve`, `Unauthorized`, `AlreadyClaimed`, `NoCommitFunds`, `VaultBelowMinTotal`, `RefundNotAvailable`, `VaultGroupInsufficientLegShare`, `VaultGroupNotAllLegsLaunched`.

---

## 8. Account types (key fields)

- **`Market`** — `authority`, `market_id`, `collateral_mint`, `yes_mint`, `no_mint`, `vault`, `start_ts`, `end_ts`, `l_zero`, `reserve_yes`, `reserve_no`, `last_accrual_ts`, `cum_yes_per_share`, `cum_no_per_share`, `total_lp_shares`, `resolved`, `winning_side` (0/1/2), `name[64]`, `initial_price_bps`, `group`.
- **`LpPosition`** — `owner`, `market`, `shares` (I80F48 bits), `collateral_deposited`, `yes_per_share_checkpoint`, `no_per_share_checkpoint`.
- **`GroupMarket`** — `authority`, `group_id`, `end_ts`, `leg_count`, `legs[32]`, `winning_leg` (0xFF = unresolved), `resolved`, `total_seeded_bps`, `name[64]`.
- **`CommitmentVault`** — `authority`, `vault_id`, `collateral_mint`, `name[64]`, `commit_end_ts`, `market_end_ts`, `yes_total`, `no_total`, `commit_count`, `min_total`, `launched`, `winning_price_bps`, `market`, `lp_position`.
- **`CommitPosition`** — `vault`, `owner`, `yes_amount`, `no_amount`, `claimed`.
- **`CommitmentVaultGroup`** — `authority`, `vault_id`, `leg_count`, `leg_names[8][32]`, `leg_totals[8]`, `commit_end_ts`, `market_end_ts`, `min_total`, `group_market_initialized`, `legs_launched`, `group_market`.
- **`CommitPositionGroup`** — `vault`, `owner`, `leg_amounts[8]`, `claimed`.

---

## 9. End-to-end recipes

**Binary market:** `createMarket` → `depositLiquidity` → `swap` (traders) → after `end_ts` `resolveMarket(side)` → holders `claimWinnings`; LPs `claimLpResiduals` + `claimWinnings` (or `withdrawLiquidity` while live).

**Commitment vault (vault = LP):** `createVault` → `vaultCommit` (crowd) → after `commit_end_ts` `launchVaultMarket` (deposits the pot) → committers `claimCommitter` (get LP shares) → trade / `withdrawLiquidity` / post-resolution `claimWinnings`. If it never reaches `min_total`, `refundCommit`.

**Multi-outcome group:** `flows.createGroup` → traders `swap` each leg → after `end_ts` `resolve_group(winning_leg)` → `flows.claimAllGroupWinnings`.

---

*Generated for the pm-AMM $PREDICT submission. Math is the Paradigm pm-AMM paper; never deviate from `doc/wp-para.md` without explicit approval.*
