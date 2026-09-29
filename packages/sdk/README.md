# @pm-amm/sdk

TypeScript SDK for the **pm-AMM** Solana program — a faithful implementation of the
[Paradigm pm-AMM](https://www.paradigm.xyz/2024/11/pm-amm) (Moallemi & Robinson, 2024):
prediction markets with time-decaying liquidity (`L_eff = L₀·√(T−t)`) for uniform
loss-versus-rebalancing, continuous LP yield, and permissionless crowd-bootstrapped
markets via **Commitment Vaults** (binary + multi-outcome).

One typed `PmAmmClient` wraps everything:

- **PDA helpers** — every account address, bound to your program id
- **Reads** — typed, decoded account fetchers
- **`ix.*`** — composable `TransactionInstruction` builders for all 34 instructions
- **`send.*`** — build + compute-budget + ATA-ensure + send, for the common case
- **`flows.*`** — multi-transaction orchestrations (group create / resolve / claim)
- **`@pm-amm/sdk/math`** — the float-64 pricing & LP-simulation math (no chain deps)

> **Coding agents (Claude / Codex):** read [`llms.txt`](./llms.txt) — a dense, complete
> API reference (every signature + type + recipes) written for LLM consumption. Live
> deployments also serve it at `/llms.txt`.
>
> **Full per-function reference:** [`doc/api-reference.md`](../../doc/api-reference.md) documents
> every on-chain instruction (accounts, args, behavior, errors) **and** every SDK function
> individually — the deep companion to this 5-minute quickstart.

## Install

```bash
pnpm add @pm-amm/sdk @solana/web3.js @anchor-lang/core @solana/spl-token
```

`@solana/web3.js`, `@anchor-lang/core` and `@solana/spl-token` are **peer dependencies** —
your app must provide a single copy of each (two copies of web3.js break
`PublicKey instanceof`). Browser consumers need a `Buffer` polyfill (Next.js, Vite et al.
provide one). The SDK ships ESM + CJS + types; ESM-via-bundler is the primary path.

## Quick start

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { PmAmmClient } from "@pm-amm/sdk";

const PROGRAM_ID = new PublicKey("GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y"); // devnet
const USDC_MINT = new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ"); // mock USDC

// Read-only (queries, no signing):
const client = PmAmmClient.readOnly(new Connection("https://api.devnet.solana.com"), PROGRAM_ID, USDC_MINT);
const markets = await client.fetchAllMarkets();

// Wallet-aware (signing): build an AnchorProvider from your wallet, then:
const signer = PmAmmClient.fromProvider(provider, PROGRAM_ID, USDC_MINT);
```

The client overrides the bundled IDL's address with your `programId` **once**, so the same
package works against any deployment.

## Reads

```ts
await client.fetchMarket(marketPda);        // MarketAccount | null
await client.fetchAllMarkets();             // { publicKey, account }[]
await client.fetchAllGroups();              // multi-outcome groups
await client.fetchAllVaults();              // binary commitment vaults
await client.fetchAllVaultGroups();         // multi-outcome commitment vaults
await client.fetchLpPosition(market, owner);
await client.fetchCommitPosition(vault, owner);

// PDAs (pure, bound to the client's program id):
client.marketPda(id); client.yesMint(market); client.noMint(market);
client.marketVault(market); client.lpPosition(market, owner);
client.vaultPda(id); client.groupPda(id); client.vaultGroupPda(id);
```

## Create a market

```ts
const { marketId, marketPda, signature } = await client.send.createMarket({
  name: "Will BTC top $200k in 2026?",
  durationSecs: 7 * 86_400,
  initialPriceBps: 5000, // 50% YES seed (0 = legacy 50/50; 100..9900 otherwise)
  depositUsdc: 250,      // optional bootstrap liquidity in the same tx
});
```

## Trade & LP

```ts
// amounts are raw 6-dp micro-units; compute your own slippage min
await client.send.swap(marketPda, "usdcToYes", 10_000_000, minOut);
await client.send.depositLiquidity(marketPda, 100);  // USDC (human units)
await client.send.withdrawLiquidity(marketPda, shares);
await client.send.redeemPair(marketPda, 5_000_000);  // burn YES+NO → USDC
await client.send.claimWinnings(marketPda);          // post-resolution
await client.send.claimLpResiduals(marketPda);

// Need to compose your own transaction? Use the builders:
const ix = await client.ix.swap({ signer, market: marketPda, direction: "usdcToYes",
  amountIn: 10_000_000, minOutput: minOut });
```

`client.ix.*` exposes all 34 instructions (`initializeMarket`, `depositLiquidity`, `swap`,
`withdrawLiquidity`, `accrue`, `claimLpResiduals`, `redeemPair`, `suggestLZero`,
`resolveMarket`, `claimWinnings`, the 5 group instructions, and the 11 vault instructions).

## Commitment vaults

```ts
// Binary: open → commit → launch (permissionless) → claim
const { vaultPda } = await client.send.createVault({
  name: "Crowd market", commitDurationSecs: 3600, marketDurationSecs: 86_400, minTotalUsdc: 50,
});
await client.send.vaultCommit(vault, "yes", 25);          // USDC
const { marketPda } = await client.send.launchVaultMarket(vault);
await client.send.claimCommitter(vault, marketPda);
// if it never launched: await client.send.refundCommit(vault);

// Multi-outcome (2–8 legs): launch is two-step — market wrapper, then one tx per leg
await client.send.createVaultGroup({ name, legNames: ["A","B","C"], commitDurationSecs, marketDurationSecs, minTotalUsdc });
await client.send.vaultCommitGroup(vault, 0, 25);
const { groupPda } = await client.send.launchVaultGroupMarket(vault);
for (let i = 0; i < legNames.length; i++) await client.send.launchVaultGroupLeg(vault, groupPda, i);
await client.send.claimCommitterGroup(vault, groupPda, legMarket, 0);
```

## Flows (multi-tx)

```ts
// Author-side group market: init group + per-leg (init + deposit + attach)
const { groupPda } = await client.flows.createGroup(
  { name: "Who wins?", legNames: ["A","B","C"], durationSecs: 86_400, budgetPerLegUsdc: 30 },
  (label, step) => console.log(step, label),
);

// Resolve (winningLeg index) or cancel (null), cascading all legs:
await client.flows.resolveGroup({ group: groupPda, legMarkets, winningLeg: 1 });

// Batch-claim a holder's winnings across all legs:
const legs = await client.flows.findClaimableLegs(legMarkets, owner);
await client.flows.claimAllGroupWinnings({ legMarkets });
```

## Pricing math — no chain needed

```ts
import { priceFromReserves, poolValue, estimateSwapOutput, lpPositionPnl } from "@pm-amm/sdk/math";

const price = priceFromReserves(reserveYes, reserveNo, lEff); // P = Φ((y−x)/L_eff)
const tvl   = poolValue(price, lEff);                          // V(P) = L_eff·φ(Φ⁻¹(P))
```

### Quotes & slippage (0.3.0+): use these, not hand-rolled math

```ts
import { marketState, quoteSwap, minOutput } from "@pm-amm/sdk/math";

const m = await client.fetchMarket(marketPda);          // or client.fetchMarkets([...]) in one call
const { price, secondsLeft, winner } = marketState(m!); // reserves rescaled to now
const q = quoteSwap(m!, "yesToUsdc", 3_000_000);         // any of the 6 directions, raw units, fee included
await client.send.swap(marketPda, "yesToUsdc", 3_000_000, minOutput(q)); // 1% slippage
```

On-chain reserves date from the last accrual and every swap accrues first, so
`priceFromReserves` / `estimateSwapOutput` on the raw stored reserves over-promise
on a market that hasn't traded for a while. `marketState` / `quoteSwap` handle it.

## Notes

- **Amounts**: `send.*` helpers take USDC in **human units** (converted to 6dp internally),
  except `swap`, which takes **raw micro-units** so you control slippage.
- **Compute budget**: `send.*` prepends the right CU budget per instruction
  (market init / launch / swap use the heavier budget; commits/refunds the default).
- **ATAs**: `send.*` auto-creates missing associated token accounts where required.

## License

MIT. Math is a port of the project's Python reference oracle; see `doc/wp-para.md` for the paper.
