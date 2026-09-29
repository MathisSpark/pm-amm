# PM-AMM — Paradigm Dynamic pm-AMM on Solana

## Project

Production implementation of the Paradigm pm-AMM paper (Moallemi & Robinson, Nov 2024).
Built for the $PREDICT hackathon. Deadline: April 26, 2026.

## Devnet

### Current deployment (Sprint 24 — fresh program ID for a clean market base)
- **Program ID**: `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`
- **USDC mock mint**: `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ` (6 decimals) — unchanged across redeploys (the mint is independent of the program ID). Mint authority = dedicated key `EftrgEw3B744jSihxjrWcX7pW7Y6WTxBJw7RhrGbU2vi` (`~/.config/solana/pm-amm-devnet-mint.json`, since 2026-09-28 — was `6NG87…`); it is the faucet's `MINT_AUTHORITY_KEY` and is NOT the upgrade key. Full devnet guide: `DEVNET.md`.
- **Upgrade authority**: `ETGKSFc7KMu32foPegEGiqFiDX3B2bPXhiFhvm8K7R6Y` (`~/.config/solana/pm-amm-devnet-upgrade.json`, since 2026-09-28 — rotated away from `6NG87…`, whose secret sat in the env of a Vercel project we lost access to). Single-key.
- **TS SDK**: `@pm-amm/sdk` (`packages/sdk`) — wraps all 34 instructions + PDAs + reads + math; the front consumes it.
- **Operator keypair**: `~/.config/solana/id.json` (`6NG87…`) — seeds markets (their authority/resolver) and funds e2e wallets; no longer upgrade or mint authority. `pnpm run deploy` signs with the upgrade key (`DEVNET_UPGRADE_KEYPAIR` to override). `pnpm run deploy` deploys/upgrades via the program keypair `anchor/target/deploy/pm_amm-keypair.json` (the prior B1fu keypair is backed up at `pm_amm-keypair.B1fu.bak.json`).

## Mainnet (LIVE)

Full guide: `MAINNET.md`. Key facts:
- **Program deployed** at `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y` (same ID as devnet — `declare_id!` compiled in, clusters isolated).
- **Upgrade authority**: `2TBg1fasPKnBczbtJpvD6LmEUxNnCoigTDQHB3VnUpv7` (dedicated mainnet key — NOT any devnet key). Single-key.
- **Real USDC**: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (Circle, 6 decimals).
- **Protocol DAO** (50% of the swap fee): `4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph`, compiled into `swap.rs` (was `HKLj…` before the Sprint 25 upgrade).
- **Sprint 25 upgrade LIVE** (2026-09-23, slot 449755892): surplus fix + Bet Vault v2 + swap creator-fee fix + LP shares ∝ L_0 + new DAO. Same `.so` as devnet (SHA-256 `5106fe71…`).
- First deployed with `MAINNET_MAX_LEN=1400000`; program data extended to **1,550,000 bytes** for Sprint 25 (an upgrade needs `solana program extend` whenever the `.so` outgrows it, plus ~7.7 SOL free on the authority for the buffer, refunded). On-chain IDL deferred (account `E4Fm…` partial, ~0.064 SOL parked; `anchor idl` lacks priority fees → congestion-blocked).
- Deploy/upgrade: `MAINNET_RPC_URL=… MAINNET_AUTHORITY_KEYPAIR=… [MAINNET_MAX_LEN=1400000] pnpm run deploy:mainnet` (interactive confirm). **Needs a dedicated RPC** (public rate-limits the writes); the script passes `--use-rpc` + a priority fee (mainnet congestion → "Max retries" otherwise).
- Front (Vercel prod env): `app/.env.mainnet.example` → `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta`, the program ID, the real USDC, a dedicated RPC. **Never set `MINT_AUTHORITY_KEY`** — faucet is hard-disabled on mainnet (UI hidden + API 503).
- Program is collateral-agnostic (mints only YES/NO, never USDC) → no on-chain change for real USDC.
- **Knowingly-accepted risks** (NOT fixed): centralized resolution (#2/#3), single-key upgrade authority, no third-party audit, multi-outcome Σ pᵢ left to arbitrage.

### History (superseded deployments)
- Sprint 24 first redeploy: program `B1fuVjvzN1r7tWPxeexqJmHCoWUHGq3Pz6TpRqH8HbBf` (same USDC `3WQ8…`) — replaced by `GV1F…` to reset to an empty market base.
- Sprint 21 multi-outcome fork: program `Dxf1PDY1sQjy3qEkekiV26rDv3W6GdkQSKx6hLLf13nK`, USDC `EaMPVLBv3TjQNpzKs3oXaXL6XHJ8aVWLGXgtwunY2xGj`.
- Upstream (Matt's Sprint 20, fully-backed): program `8V872cTKfH1gC5zBvQhrQN2DXSmRNokPPjPsBE46MZNj`, USDC `8m8VRDdvuxE4MQZBX8RqKMpuwqBYTQiME7n85Mw73j6A`.

## Stack

- **On-chain**: Anchor (Rust), `anchor-spl`, `fixed` (I80F48)
- **Frontend**: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- **Solana client**: `@anchor-lang/core`, `@solana/web3.js`, `@solana/wallet-adapter-*`
- **Package manager**: pnpm only
- **Versions**: always use latest stable — do not pin specific versions

## Commands

```bash
# From root — main aliases
pnpm run build         # Build program + IDL (anchor build + idl build)
pnpm run dev           # Frontend dev server (cd app && pnpm dev)
pnpm run deploy        # Deploy/upgrade .so on devnet (program ID GV1F…)
pnpm run seed          # Seed live devnet markets, idempotent (scripts/seed-devnet.cjs; DRY_RUN=1 to preview)
pnpm run musdc         # Mint mock USDC on devnet

# Tests
pnpm run test          # Anchor integration tests on localnet (64 TS tests across
                       # pm_amm.ts + group_market.ts + access_control.ts + vault.ts + vault_group.ts)
pnpm run test:rust     # Rust unit tests only (72 tests: pm_math, accrual, state, group, vault, vault_group)
pnpm run test:all      # Rust + Python (pytest oracle + properties)

# Quality gates
pnpm run lint          # Prettier check + Next.js lint
pnpm run lint:fix      # Auto-fix
pnpm run type-check    # Frontend TS strict typecheck (cd app && pnpm tsc --noEmit)

# Direct (from anchor/)
cd anchor && anchor build --no-idl --ignore-keys         # builds .so (ignore declare_id/keypair mismatch)
cd anchor && cargo test --package pm_amm --lib           # all Rust unit
cd anchor && cargo test --package pm_amm --lib pm_math   # one module
cd anchor && cargo test --package pm_amm --lib -- --nocapture  # show println!

# Direct (Python oracle — no pytest dependency needed)
cd oracle && python3 test_oracle.py        # 112 tests (scipy reference)
cd oracle && python3 test_properties.py    # 18 tests (paper properties A-G)
```

### Test count (must stay green)

| Suite | Count | Run with |
|---|---|---|
| Rust unit | **84** | `pnpm run test:rust` |
| TS integration — `pm_amm.ts` (binary lifecycle) | **20** | `pnpm run test` (localnet) |
| TS integration — `group_market.ts` (5 group ix) | **22** | (same) |
| TS integration — `access_control.ts` | **6** | (same) |
| TS integration — `vault.ts` (Sprint 22 commit vault) | **9** | (same) |
| TS integration — `vault_group.ts` (Sprint 23 multi-outcome vault) | **9** | (same) |
| TS integration — `lifecycle/bet_vault.ts` (Sprint 25 bet vault + surplus fix) | **21** | (same) |
| Python oracle | **112** | `python3 oracle/test_oracle.py` |
| Python properties | **18** | `python3 oracle/test_properties.py` |
| **Total (Rust + TS + Python)** | **301** | (collected manually) |

`anchor test` runs **surfpool**, not `solana-test-validator`: blocks (and the
clock) advance per transaction, not with wall time. So `tests/lifecycle/*.ts`
moves the clock by sending throwaway transfers, and it runs last (see the
`test` script in `Anchor.toml`) because it leaves the chain clock minutes ahead
of wall time, which breaks the other suites' `Date.now()`-based `end_ts`.
A surfpool left over from an earlier run is reused with its advanced clock —
`pkill -f surfpool` before `anchor test` if suites fail with `InvalidDuration`.

## Architecture

```
pm-amm/
  anchor/                # Anchor workspace
    programs/pm_amm/src/
      instructions/      # 10 binary + 5 group + 11 vault + 7 bet-vault instructions
        group/           # initialize/attach/resolve/resolve_leg/cancel
        vault/           # commitment vault (Sprint 22) + multi-outcome (23)
        bet/             # Bet Vault v2 (Sprint 25) — winner takes the pot
      pm_math.rs         # Fixed-point math (phi, Phi, Phi_inv, reserves, swap)
      accrual.rs         # dC_t mechanism — LP residual redistribution
      state.rs           # Market, LpPosition, GroupMarket accounts
      errors.rs          # Error codes
      lib.rs             # Program entrypoint
    tests/               # pm_amm.ts + group_market.ts + access_control.ts
    scripts/             # Deploy + seed scripts
  app/                   # Next.js frontend
  oracle/                # Python reference oracle (scipy)
  doc/                   # Paper reference + sprint definitions
  scripts/               # check_idl_coherence.py (CI guard)
```

## Reference Paper

`doc/wp-para.md` — Paradigm pm-AMM (Moallemi & Robinson, Nov 2024)
Source of truth for ALL math. Always cross-check before implementing.

## Critical Math Invariants

- `(y-x)*Phi((y-x)/L_eff) + L_eff*phi((y-x)/L_eff) - y = 0` — dynamic invariant (paper section 8)
- `L_eff = L_0 * sqrt(T-t)` — effective liquidity (paper section 8)
- `x*(P) = L_eff * { Phi_inv(P)*P + phi(Phi_inv(P)) - Phi_inv(P) }` — eq. (5)
- `y*(P) = L_eff * { Phi_inv(P)*P + phi(Phi_inv(P)) }` — eq. (6)
- `V(P) = L_eff * phi(Phi_inv(P))` — pool value (section 7)
- `E[LVR_t] = V_0 / (2T)` — constant expected LVR (section 8)
- `E[W_T] = W_0 / 2` — terminal wealth (section 8)
- Conservation: everything goes to LPs (YES+NO tokens) or arbitrageurs (LVR)
- Vault solvency: `vault.usdc ≥ max(yes_supply + reserve_yes, no_supply + reserve_no)` at all `t`.
  This holds ONLY because (fix #1) the first deposit calibrates `L_0` so `max(x, y) = deposit`
  (`suggest_l_zero_for_max_reserve`, not `V(P)`), and `swap` hard-reverts any trade that would
  break it. The paper's `V(P)` equals `max(x, y)` *only at P=0.5*, so the older `V(P)` calibration
  left non-0.5 / multi-outcome markets under-collateralized. With the fix, every reserve token is
  eventually distributed to LPs and the winning side always redeems 1 USDC each. Trade-off:
  skewed markets need proportionally more backing (less depth per USDC) — that is the inherent,
  correct cost of solvency. `claim_winnings` can never be locked out by an empty vault.
- NEVER deviate from the paper's math spec without explicit approval

## Architecture (Sprint 21 — multi-outcome + custom seed)

This fork builds the multi-outcome extension on top of the Sprint 17/18 swap-based AMM (the
publicly-available upstream Rust source). Matt's Sprint 20 fully-backed model (`mint_pair` +
`swap_yes_no`) is documented in upstream README/IDL but the Rust source isn't published yet —
when it is, a follow-up sprint can adapt leg seeding to use `mint_pair` instead of `swap`.

- 6-direction `swap` (USDC↔YES, USDC↔NO, YES↔NO) — legacy pm-AMM model
- `Market::initial_price_bps` (range [100, 9900], 0 = legacy 50/50) — calibrates `L_0` at any seed price
- `GroupMarket` wraps N binary markets as legs of a categorical market
- 5 group instructions: `initialize_group_market`, `attach_leg_to_group`, `resolve_group`,
  `resolve_group_leg`, `cancel_group_market`
- Σ p_i invariant tracked via `GroupMarket::total_seeded_bps` (enforced ≤ 10_001 on attach,
  ≥ `10_000 - N - (10_000 % N)` on resolve — covers the exact worst-case underseed)
- `Market::group` is **write-once**: once attached, a market can only resolve via cascade
  (`resolve_group_leg`). No `detach` instruction yet.

## Current Sprint

Sprint 25 (merged: `sparkfun-labs/pm-amm#1`; **live on devnet and mainnet** since
2026-09-23) — Bet Vault v2 + entry-side surplus fix. Spec + open items:
`doc/bet-vault-v2.md`.
- **Surplus fix**: calibrating `max(x, y) = deposit` locked collateral that no
  token could claim (73.37 USDC per 100 deposited at 70%). It is now credited as
  `LpPosition::excess_*` / `Market::unclaimed_excess_*` (carved from padding, so
  account sizes are unchanged) and minted on claim/withdraw. Already-stranded
  collateral on deployed markets is NOT recovered (4.71 USDC on mainnet).
- **Bet Vault v2**: new `BetVault`/`BetPosition` accounts + 7 instructions.
  Committers are bettors (winner takes the pot, loser 0); `effective_lp_bps` of
  the pot seeds the AMM, capped at the favourite's stake share so a winner can
  never receive less than their stake. Launch/resolve are authority/resolver-only
  and the vault PDA is `market.authority` (creator fee flows into the pot).
- **`swap` fee hole fixed**: `creator_usdc = None` now requires the signer to be
  the market authority (any trader could keep the creator's 1%).
- **Void fallback**: if the resolver never resolves, anyone can `void_bet_vault`
  after `market.end_ts + void_grace_secs` (300 s..30 d, default 7 d) and every
  committer is refunded pro-rata — no winner, no loser. Works because the vault's
  claims are equal on both sides, so the liquidity slice converts back through
  pair redemption without knowing the outcome.

### Previous — Sprint 23

Sprint 23 — Multi-outcome Commitment Vault. Permissionless crowd-bootstrapped categorical markets
(2..=8 legs). Authority sets leg names; crowd commits USDC per-leg; launch creates the GroupMarket
+ N leg markets each calibrated at `leg_total/total` bps. Refund opens if any leg < 1% share or
total < min_total. Live on devnet program `Dxf1…`. Prior sprints (21 multi-outcome + 22 binary
vault) remain on the same program.

## Rules

- EXACT formulas from the Paradigm paper
- If simplified: flag with `// SIMPLIFIED: <reason>`
- If ambiguous: choose simple + add comment
- Compute budget 400k CU on all mutative instructions
- Oracle out of scope (admin-only resolution for POC)
- Never use `rm` — use `trash` instead
- Strict TypeScript, max 70 lines per function
