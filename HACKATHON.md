# Build on pm-AMM — hackathon kit

> **You are a coding agent (Claude, Codex, Cursor…)?** This file is your entry point.
> Read it top to bottom, then follow the links in "Read next" only when you need them.
> Everything here targets **Solana devnet**: free test money, nothing has real value.

pm-AMM is an open prediction-market engine on Solana: one Anchor program
(34 instructions) that prices YES/NO outcome tokens with the Paradigm pm-AMM
curve, plus a TypeScript SDK (`@pm-amm/sdk`) that wraps all of it. You don't
write Rust: you build an app, a bot or a tool on top of the SDK.

## 1. Devnet constants

| | |
|---|---|
| Program ID | `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y` |
| Collateral | mock USDC (`mUSDC`) `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ`, 6 decimals |
| RPC | `https://api.devnet.solana.com` |
| Reference app (devnet) | <https://pm-amm-devnet.vercel.app> |
| Faucet API | `POST https://pm-amm-devnet.vercel.app/api/faucet` |
| Explorer | `https://solscan.io/account/<address>?cluster=devnet` |
| SDK | `npm i @pm-amm/sdk @solana/web3.js @anchor-lang/core @solana/spl-token` |

⚠️ The same program ID also runs on **mainnet with real USDC**. Always pass the
devnet mUSDC mint and a devnet RPC. Never paste a mainnet wallet's secret key
anywhere.

## 2. Get test funds

You need two things: **devnet SOL** (transaction fees + account rent, ~0.05 SOL
per market you create) and **mUSDC** (the collateral you trade with).

**Headless (agents, scripts):**

```bash
curl -X POST https://pm-amm-devnet.vercel.app/api/faucet \
  -H 'content-type: application/json' \
  -d '{"wallet":"<YOUR_DEVNET_PUBKEY>"}'
# → {"ok":true,"signature":"…","amount":1000,"sol":0.2}
```

- Gives **1,000 mUSDC** and creates your token account. During the hackathon it
  also drips **devnet SOL** to wallets that have little (`sol` in the response;
  `0` means it wasn't needed or isn't enabled).
- Limit: 1 claim per wallet per hour. A `429` tells you how long to wait.
- If you still have no SOL: `solana airdrop 1 <pubkey> --url devnet`, or
  <https://faucet.solana.com>. Public airdrops are rate-limited per IP and often
  dry. If they fail, ask the organisers: don't loop on them.

**In a browser wallet (humans):** switch Phantom to devnet (*Settings →
Developer settings → Testnet mode → Solana Devnet*), connect on the reference
app, click **`$FAUCET_mUSDC`** in the bottom status bar.

## 3. Zero to a live market (5 minutes)

```bash
mkdir pm-amm-quickstart && cd pm-amm-quickstart
curl -sO https://raw.githubusercontent.com/sparkfun-labs/pm-amm/main/examples/quickstart-devnet/index.cjs
curl -sO https://raw.githubusercontent.com/sparkfun-labs/pm-amm/main/examples/quickstart-devnet/package.json
npm install && node index.cjs
```

It creates `./devnet-wallet.json`, funds it through the faucet, creates a market
with 50 mUSDC of liquidity, buys YES and prints the market link. Read
[`examples/quickstart-devnet/index.cjs`](examples/quickstart-devnet/index.cjs): it
is the canonical pattern for building a signing client in Node:

```js
const { AnchorProvider, Wallet } = require("@anchor-lang/core");
const { PmAmmClient } = require("@pm-amm/sdk");
const provider = new AnchorProvider(connection, new Wallet(keypair), { commitment: "confirmed" });
const client = PmAmmClient.fromProvider(provider, PROGRAM_ID, USDC_MINT);
await client.send.createMarket({ name, durationSecs: 3600, initialPriceBps: 5000, depositUsdc: 50 });
```

In a browser app (Next.js / Vite), build the `AnchorProvider` from the wallet
adapter instead. The reference front ([`app/`](app/)) does exactly that.

## 4. Let anyone try your app: burner wallets

Your app is judged by people who won't install a wallet and switch it to
devnet. Use the **burner wallet kit**: each visitor gets a wallet created in
their browser and **funded automatically** (1,000 mUSDC + 0.02 SOL). They trade
in one tap, with no popups.

```bash
npm i @pm-amm/sdk @solana/web3.js @anchor-lang/core @solana/spl-token bs58
curl -sO https://predict-pm-amm.dev/burner/burner.ts
curl -sO https://predict-pm-amm.dev/burner/useBurnerWallet.ts
curl -sO https://predict-pm-amm.dev/helpers/pm-amm-helpers.ts   # exact quotes
```

```tsx
const { client, balances, status, error, refresh } = useBurnerWallet();
// status "ready" → client.send.swap(market, "usdcToYes", 5_000_000, minOut)
```

Full guide: [`examples/burner-wallet/README.md`](examples/burner-wallet/README.md).
Create your markets from **your own builder wallet** (the quickstart), not from
your users' burners. Devnet only: the key lives in `localStorage`.

## 5. What you can build with: the six primitives

| Primitive | SDK entry | Use it when |
|---|---|---|
| **Binary market** | `send.createMarket` (`initialPriceBps` 100..9900, default 50%) | a YES/NO question with a trading pool from t=0 |
| **Multi-outcome group** | `flows.createGroup` (2..32 legs) | "who wins?" with N answers (each leg is a binary market) |
| **Commitment vault** | `send.createVault` → `vaultCommit` → `launchVaultMarket` | the crowd funds the liquidity first; the market only launches if a target is met, committers become its LPs |
| **Multi-outcome vault** | `send.createVaultGroup` → … (2..8 legs) | same crowd bootstrap for N outcomes |
| **Bet vault** | `send.createBetVault` → `betCommit` → `launchBetVault` → `resolveBetVault` → `settleBetVault` → `claimBet` | bets between friends or 1v1: stakes set the odds, winner takes the pot, part of the pot becomes an AMM others can trade (optional allowlist of up to 8 keys) |
| **Trading / LP** | `send.swap`, `depositLiquidity`, `withdrawLiquidity`, `redeemPair`, `claimWinnings`, `claimLpResiduals` | anything that trades or provides liquidity on existing markets |

Pricing math with no chain dependency: `@pm-amm/sdk/math`
(`priceFromReserves`, `estimateSwapOutput`, `poolValue`, `simulateLpDeposit`…).

## 6. Gotchas (read these before debugging)

- **Node + ESM:** `@anchor-lang/core` is CommonJS, so `import { … } from "@pm-amm/sdk"`
  under raw Node ESM fails on `BN`. Use `require()` (`.cjs`) or a bundler.
- **Browser `Buffer`:** Vite and plain bundlers need a polyfill (`npm i buffer`).
  Setting `globalThis.Buffer` at the top of `main.tsx` is not enough (ESM imports
  are hoisted): put it in `polyfills.ts`, `import "./polyfills"` first, then
  `import("./App")` dynamically. Next.js has one.
- **One copy of web3.js:** the Solana libs are peer deps. Two copies of
  `@solana/web3.js` break `PublicKey instanceof`.
- **Units:** `send.*` takes USDC in **human** units (`50` = 50 mUSDC), **except**
  `send.swap` and `send.redeemPair`, which take **raw** 6-dp units (`5_000_000` = 5).
  `ix.*` builders always take raw units.
- **Quotes & `minOutput`: use [`pm-amm-helpers.ts`](examples/helpers/pm-amm-helpers.ts)**
  (`quoteSwap(market, direction, amountIn)` → exact output in all 6 directions,
  2% fee included; `minOutput(quote)` → 1% slippage). Don't hand-roll it: stored
  reserves date from `lastAccrualTs` and every swap accrues first, so quoting them
  against today's `L_eff` over-promises (+15–80% on a market idle for a day) and
  the swap fails with `SlippageExceeded (6007)`. `estimateSwapOutput` only covers
  buys and ignores the fee. `marketState(market)` gives the current price.
- **Public devnet RPC = rate-limited (429).** Read markets in one call
  (`fetchMarkets(client, pdas)` in the helpers), positions with
  `getMultipleParsedAccounts`, poll every ≥ 15 s and pause when the tab is hidden.
  `useBurnerWallet({ rpc })` takes your own RPC.
- **`ix.swap` needs BOTH the YES and NO token accounts** of the user, whatever the
  direction (else `AccountNotInitialized (3012)`). `send.swap` creates them;
  with `ix.*`, prepend `createAssociatedTokenAccountIdempotentInstruction` for both.
- **Resolved markets:** `market.winningSide` is `0` unresolved, `1` YES, `2` NO.
  Winners then `send.claimWinnings(market)` (1 mUSDC per winning token).
- **Durations:** markets ≥ 300 s; vault commit windows ≥ 60 s. A full
  create → trade → resolve → claim cycle takes about 5 minutes.
- **Resolution is manual:** whoever creates a market is its authority and
  resolves it after `endTs` (`send.resolveMarket(market, "yes" | "no")`). There is
  no oracle. Building one is a great hackathon project (see below).
- **Listing markets:** `client.fetchAllMarkets(443)` (443 = current account size)
  skips old-layout accounts. Devnet also holds ~46 expired test markets: filter
  on `endTs` / `resolved`.
- **Market names:** 1..64 bytes.

## 7. Ideas

- **Resolution:** an oracle adapter (Pyth / Switchboard price feeds for
  "SOL > $X by date"), a dispute window, an AI or multisig resolver.
- **Apps:** markets between friends (bet vault + a Telegram / mini-app front),
  live sports or event markets, a market on every GitHub issue or tweet.
- **Agents:** a market-making or arbitrage bot, an agent that creates markets
  from the news, an LLM that trades on its own forecasts.
- **Multi-outcome coherence:** a keeper that keeps a group's probabilities
  summing to 1.
- **Tooling:** an indexer, LP dashboards, a Python / Rust client.

## 8. Submission & judging

- **What to ship:** a **working app anyone can open and use** (a deployed URL on
  devnet, ideally with burner wallets so the jury can trade in one tap), plus its repo. A demo video is a bonus, not a substitute.
- **Judging:** at the jury's discretion. What they look for: a real, usable
  application and an **interesting use case** for prediction markets.
- **Questions / stuck:** Telegram **[@mathis_btc](https://t.me/mathis_btc)**, or
  ask the organisers in the room.

## 9. Read next (only what you need)

| Need | Read |
|---|---|
| Every SDK signature, type and recipe (dense, for agents) | [`packages/sdk/llms.txt`](packages/sdk/llms.txt) (also at `https://pm-amm-devnet.vercel.app/llms.txt`) |
| Every on-chain instruction: accounts, args, errors | [`doc/api-reference.md`](doc/api-reference.md) |
| SDK quickstart for humans | [`packages/sdk/README.md`](packages/sdk/README.md) |
| Exact quotes, market state, batched reads | [`examples/helpers/pm-amm-helpers.ts`](examples/helpers/pm-amm-helpers.ts) |
| Burner wallets for your users | [`examples/burner-wallet/README.md`](examples/burner-wallet/README.md) |
| Bet vault design + payout examples | [`doc/bet-vault-v2.md`](doc/bet-vault-v2.md) |
| Devnet ops (faucet internals, seeding, limits) | [`DEVNET.md`](DEVNET.md) |
| Repo map, math invariants | [`llms.txt`](llms.txt), [`CLAUDE.md`](CLAUDE.md) |
| The paper | [Paradigm, pm-AMM (2024)](https://www.paradigm.xyz/writing/pm-amm) |

Stuck on devnet or the SDK? Ping [@mathis_btc](https://t.me/mathis_btc) on Telegram, or open an issue on
[sparkfun-labs/pm-amm](https://github.com/sparkfun-labs/pm-amm/issues).
