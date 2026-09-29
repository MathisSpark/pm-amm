# pm-AMM — Paradigm Dynamic AMM for Prediction Markets on Solana

[![CI](https://github.com/mattdgn/pm-amm/actions/workflows/test.yml/badge.svg)](https://github.com/mattdgn/pm-amm/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF)](https://explorer.solana.com/address/GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y?cluster=devnet)
[![Anchor](https://img.shields.io/badge/Anchor-1.0-blueviolet)](https://www.anchor-lang.com/)

**First production implementation of the Paradigm pm-AMM on Solana. 100% fidelity to the paper. Uniform LVR in price and time.**

> Based on [*pm-AMM: A Prediction Market AMM*](https://www.paradigm.xyz/2024/11/pm-amm) by Ciamac Moallemi & Dan Robinson (Paradigm, Nov 2024).

**Program ID**: `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y` ([Devnet Explorer](https://explorer.solana.com/address/GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y?cluster=devnet))

**Docs**: [SDK quickstart](packages/sdk/README.md) · [full API reference](doc/api-reference.md) (every instruction + SDK function) · [the paper](doc/wp-para.md)

---

## The Math

The **dynamic pm-AMM** invariant (paper section 8):

```
(y - x) * Phi((y - x) / L_eff) + L_eff * phi((y - x) / L_eff) - y = 0
```

Where `L_eff = L_0 * sqrt(T - t)` decreases over time, and `phi`/`Phi` are the standard normal PDF/CDF.

### Three properties proven by the paper, verified on-chain:

| Property | Formula | Our test result |
|---|---|---|
| **Uniform LVR** (price-independent) | `LVR_t = V_t / (2*(T-t))` | Std across 7 prices: **0.000%** |
| **Constant E[LVR]** (time-independent) | `E[LVR_t] = V_0 / (2T)` | Linearity ratio: **0.994** (500 MC runs) |
| **LP wealth at expiry** | `E[W_T] = W_0 / 2` | Measured: **0.518** (500 MC runs, 5% tolerance) |

---

## The dC_t Mechanism — Why This is Different

Traditional AMMs leave LPs fully exposed until they withdraw. The pm-AMM actively redistributes liquidity to LPs over time:

```
deposit 1000 USDC         claim YES+NO          redeem for USDC
       |                       |                       |
       v                       v                       v
  |---------|---------|---------|---------|---------| 
  t=0       t=1d      t=2d      t=3d      ...     T
            |         |         |
            v         v         v
       dC_t accrual: tokens released as L_eff decreases
```

As time passes, `L_eff = L_0 * sqrt(T-t)` shrinks. The reserves scale proportionally, releasing YES+NO tokens to LPs via per-share accumulators. LPs can:
1. **Claim** YES+NO tokens at any time
2. **Redeem** 1 YES + 1 NO = 1 USDC (pair redemption)
3. **Sell** on the pool via swap
4. **Hold** until resolution for the winning side

### Conservation verified:

At fixed price (no arbitrage), 100% of pool value returns to LPs. With random walks (Gaussian score dynamics), exactly 50% returns (the other 50% is LVR consumed by arbitrageurs). Both verified in our test suite.

---

## Architecture

```
pm-amm/
  anchor/                # Solana program (Anchor/Rust)
    programs/pm_amm/src/
      pm_math.rs         # Fixed-point math (phi, Phi, Phi_inv, reserves, swap)
      accrual.rs         # dC_t mechanism (compute, apply, accrue_first)
      lut.rs             # 2048-point lookup tables for on-chain perf
      state.rs           # Market, LpPosition structs
      errors.rs          # Error codes
      instructions/      # 11 instructions (fully-backed architecture, Sprint 20)
    tests/               # 64 TS integration tests (pm_amm + group_market + access_control + vault + vault_group)
    scripts/             # Deploy + seed scripts
  app/                   # Next.js frontend (with /create-group and /group/[id] pages)
  oracle/                # Python truth oracle (scipy reference)
  doc/                   # Paper reference, PRD, sprint definitions
  scripts/               # check_idl_coherence.py (CI guard against IDL drift)
```

### 15 Instructions (10 binary + 5 group-market EXTENSION)

| Instruction | Who | Description |
|---|---|---|
| `initialize_market` | Anyone | Create market with YES/NO mints + USDC vault. `initial_price_bps` (`[100, 9900]`, `0` = legacy 50/50) seeds the YES price at first deposit |
| `deposit_liquidity` | LP | Add USDC, get shares. First deposit bootstraps `L_0` at the configured seed price |
| `swap` | Trader | 6 directions: USDC ↔ YES, USDC ↔ NO, YES ↔ NO |
| `withdraw_liquidity` | LP | Burn shares, receive YES+NO proportional |
| `accrue` | Anyone | Permissionless dC_t accrual (keeper) |
| `claim_lp_residuals` | LP | Claim accrued YES+NO tokens |
| `redeem_pair` | Holder | Burn 1 YES + 1 NO → 1 USDC |
| `resolve_market` | Authority | Set winning side after expiration. Rejects legs attached to a group (cascade only) |
| `claim_winnings` | Holder | Burn winning tokens for 1 USDC each |
| `suggest_l_zero` | Anyone | View: compute optimal L_0 for a budget |
| `initialize_group_market` | Anyone | **EXTENSION**: create a categorical market with N legs |
| `attach_leg_to_group` | Group auth | Bind a binary market as leg at `10_000 / N` bps (±1 tolerance) |
| `resolve_group` | Group auth | Pick the winning leg after expiration; enforces Σ p_i ≈ 1 |
| `resolve_group_leg` | Anyone | Cascade-resolve one leg of a resolved group (winning → Yes, others → No) |
| `cancel_group_market` | Group auth | Mark an abandoned group resolved with `NO_WINNING_LEG` — legs cascade to `Side::No` |

**Conservation invariant**: by construction of the pm-AMM curve + dC_t mechanism, `vault.usdc ≥ max(yes_supply, no_supply)` at all `t` — winners can always be paid 1 USDC per winning token. The `.min(vault.amount)` in `claim_winnings` is defensive code for a case the math forbids.

> Upstream `main` documents a fully-backed Sprint 20 architecture (`mint_pair` + `swap_yes_no` with `vault.usdc == yes_mint.supply == no_mint.supply`). The Rust source for that variant isn't published yet; this fork ports multi-outcome onto the public Sprint 17 swap-based code. When Matt publishes Sprint 20, a follow-up sprint can adapt leg seeding to use `mint_pair` instead of `swap`.

---

## Robustness Beyond the Gaussian Model

| Test | Setup | Result |
|---|---|---|
| **Jump** (deterministic) | P=0.5 -> P=0.87 in one swap | Invariant: **0.00e+00**, no overflow |
| **MC with jumps** | 200 runs, 20% jump probability | LVR -35.8% vs Gaussian (lower because jumps push prices to extremes where V is lower) |
| **100 random swaps** | Alternating directions, random sizes | Max invariant: **9e-13** |

---

## Composability

All accounts are deterministic PDAs:

```typescript
// Derive all addresses from market_id alone
const [market] = PublicKey.findProgramAddressSync(
  [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
  PROGRAM_ID
);
const [yesMint] = PublicKey.findProgramAddressSync(
  [Buffer.from("yes_mint"), market.toBuffer()], PROGRAM_ID
);
// ... same for no_mint, vault
```

`suggest_l_zero` is callable via CPI for auto-LP vaults:

```typescript
await program.methods
  .suggestLZero(budgetUsdc, sigmaBps)
  .accounts({ market })
  .rpc();
// Emits LZeroSuggestion event with suggested_l_zero, daily_lvr, warnings
```

---

## IDL

The Anchor IDL is available at [`idl/pm_amm.json`](idl/pm_amm.json) for integrators building on top of pm-AMM.

---

## Test Suite

**266 tests total:**

| Category | Count | Coverage |
|---|---|---|
| Rust unit tests (`pm_math`, `accrual`, `state`, group, vault, vault_group) | 72 | All math functions, Q64.64 roundtrips, accrual properties, solver precision, group invariants, `min_sum` formula proof, vault + multi-outcome vault state |
| TS integration — `pm_amm.ts` | 18 | Full lifecycle binary: init → deposit → swap → claim → resolve |
| TS integration — `group_market.ts` | 22 | 5 group instructions: happy paths + every reachable error code on localnet, including `total_seeded_bps` overflow and underseed |
| TS integration — `access_control.ts` | 6 | Permissionless paths (accrue, redeem) + signer-bound LpPosition checks |
| TS integration — `vault.ts` (Sprint 22 binary commitment vault) | 9 | 5 vault instructions: init/commit/launch/claim/refund + edge cases (too-small commit, premature launch, refund path) |
| TS integration — `vault_group.ts` (Sprint 23 multi-outcome commitment vault) | 9 | 6 vault group instructions: init/commit/launch_market/launch_leg/claim/refund + edge cases (leg-index OOB, leg-count bounds, too-small commit, premature launch / refund) |
| Python property tests | 18 | Paradigm properties A/B/C, robustness D/E/F, initial-price G |
| Python oracle tests | 112 | Cross-validation against scipy |

Run with:

```bash
pnpm run test:rust   # Rust unit (72)
pnpm run test        # TS integration on localnet (64 — boots surfpool with Metaplex cloned from devnet)
pnpm run test:all    # Rust + Python (skips TS)
python3 oracle/test_oracle.py && python3 oracle/test_properties.py  # Python (130)
```

---

## Known Limitations

- **Oracle**: admin-only resolution (no oracle integration). For mainnet, replace with
  Pyth/Switchboard or a multisig with appeal timelock.
- **Multi-outcome rebalancing**: Σ p_i = 1 is enforced on-chain at seed and at resolution; keeping
  it tight *between* trades is left to an off-chain dispatcher (Vyber pattern).
- **Protocol fee**: a 2% fee on USDC↔YES/NO swaps, split 50% to the protocol DAO and 50% to the
  market creator. Pure YES↔NO swaps are fee-free. The fee does **not** accrue to LPs — their
  economics remain the curve spread + `dC_t`/LVR.
- **Single-key upgrade authority**: not mainnet-grade. Move to a Squads multisig before any
  production deployment.

## Roadmap

- [x] Multi-outcome markets (categorical pm-AMM, composed of N binary legs — Sprint 21)
- [ ] Adopt Matt's Sprint 20 fully-backed model (`mint_pair` + `swap_yes_no`) once the Rust source is published upstream
- [ ] On-chain dispatcher for atomic inter-leg Σ p_i rebalancing
- [ ] Oracle integration (Switchboard/Pyth for auto-resolution)
- [x] Protocol swap fee — 2% on USDC↔YES/NO, split 50% DAO / 50% market creator
- [ ] LP-directed fees (incentive beyond `dC_t`)
- [ ] Delta hedging tools for sophisticated LPs

---

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Solana CLI](https://docs.solanalabs.com/cli/install) (v3+)
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) (v1.0+)
- [Node.js](https://nodejs.org/) (v20+)
- [pnpm](https://pnpm.io/) (v9+)
- Python 3.10+ (for oracle tests only)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build the program (anchor build + idl build)
pnpm run build

# Run Rust unit tests (72 tests)
pnpm run test:rust

# Run integration tests (64 tests, requires local validator)
pnpm run test

# Run Python oracle + property tests (130 tests)
cd oracle && python3 test_oracle.py && python3 test_properties.py

# Run everything except TS integration
pnpm run test:all

# Start the frontend
pnpm run dev

# Deploy to devnet
pnpm run deploy
```

Devnet (mock USDC, faucet, operator tasks): see [DEVNET.md](DEVNET.md). Mainnet: [MAINNET.md](MAINNET.md).

## Environment Variables

Copy `.env.example` to `.env.local` in the `app/` directory:

```bash
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
KV_REST_API_URL=            # Upstash Redis (optional, for price history)
KV_REST_API_TOKEN=          # Upstash Redis (optional)
MINT_AUTHORITY_KEY=         # Base64-encoded keypair for mock USDC faucet
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code standards, and PR guidelines.

## License

[MIT](LICENSE)

---

Built for the [$PREDICT hackathon](https://justspark.fun/hackathons/$PREDICT) by [@matt](https://x.com/mattdgn).

Paper: [Paradigm pm-AMM](https://www.paradigm.xyz/2024/11/pm-amm) (Moallemi & Robinson, Nov 2024)
