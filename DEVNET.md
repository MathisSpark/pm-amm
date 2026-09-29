# Devnet guide

Devnet is the **free test environment** for pm-AMM: the program's bytecode is
identical to mainnet's, but the collateral is a **mock USDC (mUSDC)** that
anyone can get from the in-app faucet. Nothing on devnet has real value.

Use it to try the product, to demo it, and to run end-to-end tests against a
real validator before an upgrade goes to mainnet.

**Live front: <https://pm-amm-devnet.vercel.app>**

## At a glance

| | Devnet | Mainnet (see [`MAINNET.md`](MAINNET.md)) |
|---|---|---|
| Program ID | `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y` | same (`declare_id!` is compiled in; clusters are isolated) |
| Upgrade authority | `ETGKSFc7KMu32foPegEGiqFiDX3B2bPXhiFhvm8K7R6Y` (`~/.config/solana/pm-amm-devnet-upgrade.json`, since 2026-09-28 — was `6NG87…`) | `2TBg1fas…UpV7` (dedicated key) |
| Collateral | mock USDC `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ` (6 decimals, symbol `mUSDC`) | real USDC `EPjFWdd5…Dt1v` |
| mUSDC mint authority | `EftrgEw3B744jSihxjrWcX7pW7Y6WTxBJw7RhrGbU2vi` (`~/.config/solana/pm-amm-devnet-mint.json`, dedicated — cannot upgrade the program) | none — real USDC is not mintable |
| Faucet | ✅ 1,000 mUSDC per claim (1 / wallet / hour, 5 / IP / day) | ❌ hard-disabled (UI hidden + API 503) |
| RPC | `https://api.devnet.solana.com` (public is fine) | dedicated provider required |
| Explorer | [Solscan (devnet)](https://solscan.io/account/GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y?cluster=devnet) | Solscan (no `?cluster=`) |

The program is **collateral-agnostic**: it only mints YES/NO tokens and never
touches the USDC mint, so the same `.so` runs against mUSDC on devnet and real
USDC on mainnet. The front picks the mint from `NEXT_PUBLIC_USDC_MINT`.

---

## 1. Using devnet (tester / demo)

1. **Switch your wallet to devnet.** Phantom: *Settings → Developer settings →
   Testnet mode → Solana Devnet*. Solflare/Backpack have an equivalent network
   toggle. On the wrong network, balances show as 0 and transactions fail.
2. **Get devnet SOL** (to pay transaction fees): <https://faucet.solana.com>, or
   `solana airdrop 1 <your-address> --url devnet`. Airdrops are rate-limited
   per IP; 0.5 SOL is enough for dozens of trades.
3. **Connect the wallet** on the app, then click **`$FAUCET_mUSDC`** in the
   bottom status bar. You receive **1,000 mUSDC** (the faucet pays the fee and
   creates your token account; you don't need SOL for this step). One claim
   per wallet per hour, five per network (IP) per day.
4. **Trade.** Buy YES/NO on a market, provide liquidity, create a market, a
   commitment vault (`+ VAULT`), a multi-outcome group (`+ GROUP`) or a bet
   vault. Every flow behaves as on mainnet.
5. **Resolution** is admin-only (as on mainnet): the market's authority / the
   vault's resolver picks the outcome after `end_ts`. Winners then claim 1 mUSDC
   per winning token. A bet vault nobody resolves can be voided by anyone after
   `end_ts + void_grace_secs` and everyone is refunded.

Minimum durations enforced on-chain: markets and groups ≥ 300 s, vault commit
windows ≥ 60 s — so a full create → trade → resolve → claim cycle takes about
5 minutes on devnet.

---

## 2. How the faucet works

`POST /api/faucet` — [`app/src/app/api/faucet/route.ts`](app/src/app/api/faucet/route.ts),
called by the button in [`status-bar.tsx`](app/src/components/layout/status-bar.tsx).

```
browser ──POST {wallet}──▶ Next.js API route (server side, on Vercel)
                              │  1. refuses if NEXT_PUBLIC_SOLANA_CLUSTER = mainnet-beta (503)
                              │  2. refuses if MINT_AUTHORITY_KEY is unset (503)
                              │  3. refuses a malformed / off-curve address (400)
                              │  4. rate limits: wallet → IP → global (429 + Retry-After)
                              │  5. creates the recipient's mUSDC ATA if missing
                              │  6. mintTo 1,000 mUSDC, signed + paid by the mint authority
                              ▼
                        devnet RPC (NEXT_PUBLIC_RPC_URL)
```

- The mint authority is a **dedicated key** (`EftrgEw3…`), separate from the
  upgrade authority (`ETGKSFc7…`): a leak of the faucet secret can mint worthless
  mUSDC and spend that key's SOL, but it cannot touch the program.
- Its secret lives **only** in the server env var `MINT_AUTHORITY_KEY` (base64
  of the 64-byte secret key). It is never sent to the browser (no
  `NEXT_PUBLIC_` prefix).
- The mint authority **pays** every faucet call: ~0.000005 SOL of fee, plus
  ~0.002 SOL of rent when it creates a new token account. Keep its devnet SOL
  topped up (`solana balance EftrgEw3B744jSihxjrWcX7pW7Y6WTxBJw7RhrGbU2vi --url devnet`).

### Rate limits

Defined in `LIMITS` in the route, counted by
[`app/src/lib/rate-limit.ts`](app/src/lib/rate-limit.ts) (fixed windows):

| Scope | Limit | Why |
|---|---|---|
| wallet | 1 claim / hour | stops one user spamming the button |
| IP (`x-forwarded-for`) | 5 claims / day (`FAUCET_IP_DAILY_LIMIT`) | stops a script creating fresh wallets to drain the authority's SOL |
| global | 500 claims / day (`FAUCET_GLOBAL_DAILY_LIMIT`) | hard cap: ≤ ~1 SOL of rent spent per day |

A refused request doesn't count against the other scopes, and a failed mint
gives the quota back.

### SOL drip

`FAUCET_SOL_DRIP` (in SOL, e.g. `0.2`; unset = off) makes the same transaction
also send that much devnet SOL to recipients holding less than it, paid by the
mint authority. Public devnet airdrops are rate-limited per IP and often dry, so
without it a new builder can hold 1,000 mUSDC and still be unable to pay a fee.
The response then carries `"sol": <amount sent>`.

### Event mode (in-person hackathon)

Everyone in the room shares one public IP, so the default 5 claims / IP / day
locks the whole room out after five people. For the event, on the
`pm-amm-devnet` Vercel project (Production), set:

```bash
FAUCET_IP_DAILY_LIMIT=300       # 30 builders × a few wallets each
FAUCET_GLOBAL_DAILY_LIMIT=1000
FAUCET_SOL_DRIP=0.2             # ~4 markets' worth of rent + fees per wallet
```

then **redeploy** (server env is bound per deployment) and top up the mint
authority: 30 wallets × (0.2 SOL + ~0.002 rent) ≈ **6 SOL**, plus margin →
`solana transfer EftrgEw3B744jSihxjrWcX7pW7Y6WTxBJw7RhrGbU2vi 10 --url devnet`.
Remove the three variables and redeploy after the event.

⚠️ The counters live in **Upstash Redis** (`KV_REST_API_URL` /
`KV_REST_API_TOKEN`) when it's configured. Without it they fall back to
process memory, which is per serverless instance and resets on cold starts:
fine locally, **too weak for a public deploy** — set the KV variables on any
public devnet deployment.

Headless (agents, scripts):

```bash
curl -X POST https://pm-amm-devnet.vercel.app/api/faucet \
  -H 'content-type: application/json' -d '{"wallet":"<pubkey>"}'
```

Responses: `{ ok, signature, amount, sol }` on success; `400` missing / invalid
wallet; `429` rate limited (`Retry-After` header, message says how long);
`500` RPC error; `503` faucet not configured or mainnet.

---

## 3. Running the front against devnet

`app/.env.local` (not committed):

```bash
NEXT_PUBLIC_SOLANA_CLUSTER=devnet
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_PROGRAM_ID=GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y
NEXT_PUBLIC_USDC_MINT=3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ

# Faucet (server-only). Base64 of the DEDICATED mint authority's secret key:
#   node -e 'console.log(Buffer.from(require(require("os").homedir()+"/.config/solana/pm-amm-devnet-mint.json")).toString("base64"))'
MINT_AUTHORITY_KEY=

# Upstash Redis — sparklines + faucet rate limits. Optional locally (sparklines
# fall back to seed data, limits to process memory); REQUIRED on a public deploy.
KV_REST_API_URL=
KV_REST_API_TOKEN=
```

```bash
pnpm install
pnpm run build:sdk
pnpm run dev            # http://localhost:3000
```

All four `NEXT_PUBLIC_*` values default to devnet in
[`app/src/lib/constants.ts`](app/src/lib/constants.ts), so the app runs on
devnet even with an empty env — only the faucet needs `MINT_AUTHORITY_KEY`.

### Vercel

Project **`pm-amm-devnet`** (account `ewuly`, team `ewulys-projects`), created
2026-09-28 — the previous project (`ewans-projects-b0b35061`) is no longer
accessible. Public URL: <https://pm-amm-devnet.vercel.app>.

- Root Directory `app/`; install/build come from [`app/vercel.json`](app/vercel.json)
  (workspace install, then SDK build, then the app).
- Deployed from the CLI at the repo root (`.vercel/` is linked there, git-ignored):
  `vercel deploy --prod`. [`.vercelignore`](.vercelignore) keeps `anchor/target`
  (GBs) and other non-front folders out of the upload. Not connected to Git yet.
- Env (Production + Preview): the four `NEXT_PUBLIC_*` above, `MINT_AUTHORITY_KEY`
  (Production, *sensitive*), and the Upstash vars (`KV_REST_API_URL`,
  `KV_REST_API_TOKEN`, …) injected by the **Storage → Upstash for Redis**
  integration connected to the project.
- Setting / rotating the faucet key without printing it (from the repo root):
  ```bash
  node -e 'process.stdout.write(Buffer.from(JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.config/solana/pm-amm-devnet-mint.json"))).toString("base64"))' | vercel env add MINT_AUTHORITY_KEY production --sensitive
  ```
- `NEXT_PUBLIC_*` values are inlined at build time, and server env is bound per
  deployment: **redeploy after any env change**.
- Never put devnet values in a mainnet project, and never set
  `MINT_AUTHORITY_KEY` there.

---

## 4. Operator tasks

Three keys, all local and never committed:

| Key | File | Role | Override |
|---|---|---|---|
| `ETGKSFc7…` | `~/.config/solana/pm-amm-devnet-upgrade.json` | program upgrade authority **only** (`pnpm run deploy`) | `DEVNET_UPGRADE_KEYPAIR` |
| `EftrgEw3…` | `~/.config/solana/pm-amm-devnet-mint.json` | mUSDC mint authority only (faucet + `musdc` + e2e top-ups) | `MINT_AUTHORITY_KEYPAIR` |
| `6NG87…` | `~/.config/solana/id.json` | operator: seeds markets (= their authority / resolver), funds e2e wallets | `SEED_KEYPAIR` (seed) |

`6NG87…` was the upgrade + mint authority until 2026-09-28. Its secret was in
the env of a Vercel project we no longer control, so both roles were rotated
away from it; it only keeps operator duties (low stakes: it can resolve the
markets it created and spend its own SOL). Only the faucet key goes on Vercel.

| Task | Command |
|---|---|
| Build `.so` + IDL | `pnpm run build` |
| Deploy / upgrade the program | `pnpm run deploy` (signs with the upgrade key; it needs ~8 SOL free for the upgrade buffer, refunded — airdrop / transfer to `ETGKSFc7…` first) |
| Mint mUSDC manually | `pnpm run musdc <wallet> <amount>` (defaults: the mint key's own wallet, 1,000) |
| Seed live demo markets | `pnpm run seed` (see below) |
| E2E against devnet | `NODE_PATH="$PWD/app/node_modules" node scripts/e2e-devnet.cjs` (also `e2e-full.cjs`, `e2e-vault.cjs`; bet vault: `pnpm run build:sdk && NODE_PATH=packages/sdk/node_modules node scripts/e2e-bet-vault-devnet.cjs`, ~7 min) |
| Throwaway UI test wallet | `node scripts/setup-dev-wallet.cjs` (funds 0.5 SOL, writes `NEXT_PUBLIC_DEV_WALLET_SECRET` to `app/.env.local`) |
| Check state | `solana program show GV1F… --url devnet` · `spl-token display 3WQ8… --url devnet` |

Upgrade flow: always ship to devnet first, run the e2e scripts, then apply the
**same `.so`** to mainnet (compare SHA-256) with `pnpm run deploy:mainnet`.

### Seeding

`pnpm run seed` builds the SDK and runs [`scripts/seed-devnet.cjs`](scripts/seed-devnet.cjs):
5 binary markets + 1 three-way group (`MARKETS` / `GROUPS` at the top of the
file: name, end date, seed price, initial liquidity), created through the SDK
like the front does.

- **Idempotent**: anything whose name is already live (unresolved, not expired)
  is skipped. Re-run it whenever markets expire, after editing the list with
  new dates.
- Signs with `id.json` (override `SEED_KEYPAIR=<path>`), so `6NG87…` is the
  authority and resolver of the seeded markets.
- Tops up the seeder's mUSDC from the mint key if it's short.
- `DRY_RUN=1 pnpm run seed` prints the plan without sending anything.

Seeded on 2026-09-28 (expiries 2026-10-04 → 2026-12-31): SOL > $200 (Oct 4),
BTC dominance > 60% (Oct 31), SOL > $300 (Nov 30), Fed cut (Dec), BTC > $150k
(Dec 31), and the group *Best performer in Q4 2026* (BTC / ETH / SOL). **The
operator has to resolve them** after each end date, from the market page (as
authority) or `client.send.resolveMarket` / `client.flows.resolveGroup`.

---

## 5. Known limitations

- **Old test markets stay listed**: ~46 expired e2e/smoke markets show under
  *All* / *Resolved*. Accounts can't be hidden on-chain; the *Active* filter
  shows only the seeded ones.
- **Seeded markets need manual resolution** and re-seeding when they expire.
- **Faucet limits need Redis on a public deploy** (see §2) — connected on
  `pm-amm-devnet`; keep it that way on any new project.
- The e2e scripts fund throwaway wallets from `id.json`, which only keeps
  ~0.3 SOL: top it up before running them.
- The mint key (`EftrgEw3…`) pays for the faucet: top it up when it runs low
  (1 SOL on 2026-09-28 ≈ 450 new-wallet claims).
- **Devnet may be reset** by Solana Labs; if it happens, redeploy the program
  and recreate the mint (and update `NEXT_PUBLIC_USDC_MINT` + `tokens.ts`).
- Same trust model as mainnet: centralized resolution, single-key authority,
  no third-party audit.
