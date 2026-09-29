/**
 * Seed devnet with a few LIVE demo markets (binary + one multi-outcome group),
 * through the SDK — the exact paths the front uses.
 *
 * Idempotent: a market/group whose name is already live (unresolved, end_ts in
 * the future) is skipped, so re-running only fills the gaps. Tops up the
 * seeder's mUSDC from the dedicated mint authority when it's short.
 *
 *   pnpm run seed
 *
 * Env (all optional):
 *   SEED_KEYPAIR            signer + market authority (= resolver). Default ~/.config/solana/id.json
 *   MINT_AUTHORITY_KEYPAIR  mUSDC mint authority.  Default ~/.config/solana/pm-amm-devnet-mint.json
 *   NEXT_PUBLIC_RPC_URL     default https://api.devnet.solana.com
 *   DRY_RUN=1               print the plan, send nothing
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, mintTo } = require("@solana/spl-token");
const anchor = require("@anchor-lang/core");
const { PmAmmClient, decodeName } = require("../packages/sdk/dist/index.cjs");

const PROGRAM = new PublicKey("GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y");
const USDC = new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ");
const RPC = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
const DRY_RUN = process.env.DRY_RUN === "1";

// `end` is an ISO UTC date; `priceBps` the seed YES price; `usdc` the initial LP deposit.
const MARKETS = [
  {
    name: "Will SOL close above $200 on Oct 4, 2026?",
    end: "2026-10-04T23:59:00Z",
    priceBps: 5000,
    usdc: 250,
  },
  {
    name: "BTC dominance above 60% on Oct 31, 2026?",
    end: "2026-10-31T23:59:00Z",
    priceBps: 5000,
    usdc: 250,
  },
  {
    name: "Will SOL trade above $300 by Nov 30, 2026?",
    end: "2026-11-30T23:59:00Z",
    priceBps: 2500,
    usdc: 250,
  },
  {
    name: "Will the Fed cut rates in December 2026?",
    end: "2026-12-20T23:59:00Z",
    priceBps: 5000,
    usdc: 250,
  },
  {
    name: "Will BTC close above $150k on Dec 31, 2026?",
    end: "2026-12-31T23:59:00Z",
    priceBps: 3000,
    usdc: 250,
  },
];
const GROUPS = [
  {
    name: "Best performer in Q4 2026",
    legs: ["BTC", "ETH", "SOL"],
    end: "2026-12-31T23:59:00Z",
    usdcPerLeg: 100,
  },
];

const home = (p) => path.join(os.homedir(), p);
const loadKeypair = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p))));
const nowS = () => Math.floor(Date.now() / 1000);
const secsUntil = (iso) => Math.floor(Date.parse(iso) / 1000) - nowS();

class NodeWallet {
  constructor(payer) {
    this.payer = payer;
  }
  get publicKey() {
    return this.payer.publicKey;
  }
  async signTransaction(tx) {
    tx.partialSign(this.payer);
    return tx;
  }
  async signAllTransactions(txs) {
    txs.forEach((t) => t.partialSign(this.payer));
    return txs;
  }
}

/** Names of markets/groups that are still live (unresolved, not expired). */
async function liveNames(client) {
  const live = (a) => !a.resolved && Number(a.endTs.toString()) > nowS();
  const [markets, groups] = await Promise.all([client.fetchAllMarkets(), client.fetchAllGroups()]);
  return new Set(
    [...markets, ...groups].filter((x) => live(x.account)).map((x) => decodeName(x.account.name)),
  );
}

async function ensureUsdc(connection, seeder, needUsdc) {
  const ata = await getOrCreateAssociatedTokenAccount(connection, seeder, USDC, seeder.publicKey);
  const have = Number(ata.amount) / 1e6;
  if (have >= needUsdc) return console.log(`mUSDC: ${have} (enough)`);
  const topUp = Math.ceil(needUsdc - have);
  const mintKey =
    process.env.MINT_AUTHORITY_KEYPAIR || home(".config/solana/pm-amm-devnet-mint.json");
  if (DRY_RUN) return console.log(`mUSDC: ${have} — would mint ${topUp}`);
  await mintTo(connection, seeder, USDC, ata.address, loadKeypair(mintKey), topUp * 1e6);
  console.log(`mUSDC: ${have} + ${topUp} minted`);
}

function validate() {
  for (const x of [...MARKETS, ...GROUPS]) {
    if (Buffer.byteLength(x.name) > 64) throw new Error(`name > 64 bytes: ${x.name}`);
    if (secsUntil(x.end) < 300) throw new Error(`ends in < 300s (on-chain min): ${x.name}`);
  }
}

(async () => {
  validate();
  const seeder = loadKeypair(process.env.SEED_KEYPAIR || home(".config/solana/id.json"));
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new NodeWallet(seeder), {
    commitment: "confirmed",
  });
  const client = PmAmmClient.fromProvider(provider, PROGRAM, USDC);
  console.log(
    `seeder/authority: ${seeder.publicKey.toBase58()}  rpc: ${RPC}${DRY_RUN ? "  (dry run)" : ""}`,
  );

  const live = await liveNames(client);
  const markets = MARKETS.filter((m) => !live.has(m.name));
  const groups = GROUPS.filter((g) => !live.has(g.name));
  const need =
    markets.reduce((s, m) => s + m.usdc, 0) +
    groups.reduce((s, g) => s + g.usdcPerLeg * g.legs.length, 0);
  console.log(
    `to create: ${markets.length} markets, ${groups.length} groups (${need} mUSDC); already live: ${live.size}`,
  );
  if (need > 0) await ensureUsdc(connection, seeder, need + 1);

  for (const m of markets) {
    if (DRY_RUN) {
      console.log(`  would create "${m.name}"`);
      continue;
    }
    const r = await client.send.createMarket({
      name: m.name,
      durationSecs: secsUntil(m.end),
      initialPriceBps: m.priceBps,
      depositUsdc: m.usdc,
    });
    console.log(`  ✓ ${m.name} → ${r.marketPda}`);
  }
  for (const g of groups) {
    if (DRY_RUN) {
      console.log(`  would create group "${g.name}"`);
      continue;
    }
    const r = await client.flows.createGroup({
      name: g.name,
      legNames: g.legs,
      durationSecs: secsUntil(g.end),
      budgetPerLegUsdc: g.usdcPerLeg,
    });
    console.log(`  ✓ group ${g.name} → ${r.groupPda}`);
  }
  console.log("done");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
