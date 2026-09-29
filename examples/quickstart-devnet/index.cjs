// pm-AMM devnet quickstart — zero to a live market in one command.
//
//   npm install && node index.cjs
//   (deps: @pm-amm/sdk @solana/web3.js @anchor-lang/core @solana/spl-token)
//
// 1. loads (or creates) a local devnet keypair: ./devnet-wallet.json
// 2. claims 1,000 mUSDC from the faucet API if the wallet has < 50 mUSDC
//    (during events the faucet also drips devnet SOL for fees)
// 3. falls back to a public devnet SOL airdrop if the wallet still has < 0.05 SOL
// 4. creates a binary market seeded with 50 mUSDC of liquidity
// 5. buys YES with 5 mUSDC, with a real slippage bound
// 6. prints the price and a link to the market in the reference app
//
// CommonJS on purpose: @anchor-lang/core is CJS, so the SDK's ESM build fails
// under raw Node (named `BN` import). Use require(), or a bundler.

const fs = require("fs");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const { AnchorProvider, Wallet } = require("@anchor-lang/core");
const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
const { PmAmmClient } = require("@pm-amm/sdk");
const { i80f48ToNumber, priceFromReserves, estimateSwapOutput } = require("@pm-amm/sdk/math");

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const APP = "https://pm-amm-devnet.vercel.app";
const PROGRAM_ID = new PublicKey("GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y");
const USDC_MINT = new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ"); // devnet mock USDC (mUSDC), 6 dp
const WALLET_FILE = process.env.WALLET || "./devnet-wallet.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadWallet() {
  if (fs.existsSync(WALLET_FILE)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(WALLET_FILE, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`created ${WALLET_FILE} (devnet only — never reuse on mainnet)`);
  return kp;
}

async function ensureSol(conn, pubkey) {
  const bal = await conn.getBalance(pubkey);
  if (bal >= 0.05 * LAMPORTS_PER_SOL) return bal;
  console.log("requesting a devnet SOL airdrop…");
  try {
    const sig = await conn.requestAirdrop(pubkey, 1 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  } catch (e) {
    console.error(
      `\nairdrop refused (${e.message.split("\n")[0]}).\n` +
        `Public devnet airdrops are rate-limited per IP. Get SOL another way, then re-run:\n` +
        `  - https://faucet.solana.com  (paste ${pubkey.toBase58()})\n` +
        `  - ask the hackathon organisers / a neighbour for 0.2 devnet SOL\n`,
    );
    process.exit(1);
  }
  return conn.getBalance(pubkey);
}

async function usdcBalance(conn, owner) {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, owner);
  try {
    return Number((await conn.getTokenAccountBalance(ata)).value.uiAmount);
  } catch {
    return 0; // no token account yet
  }
}

async function ensureUsdc(conn, owner) {
  if ((await usdcBalance(conn, owner)) >= 50) return;
  console.log("claiming 1,000 mUSDC from the faucet…");
  const res = await fetch(`${APP}/api/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: owner.toBase58() }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`faucet ${res.status}: ${body.error}`);
    process.exit(1);
  }
  await conn.confirmTransaction(body.signature, "confirmed");
  if (body.sol) console.log(`faucet also sent ${body.sol} devnet SOL`);
}

/**
 * Current YES price + L_eff, with reserves rescaled to now. Stored reserves date
 * from `lastAccrualTs`, and every swap accrues first, so quoting them against
 * today's L_eff over-promises (by 15-80% on a market idle for a day).
 * For exact quotes in all 6 directions, use examples/helpers/pm-amm-helpers.ts.
 */
function marketState(m) {
  const now = Math.floor(Date.now() / 1000);
  const endTs = m.endTs.toNumber();
  const lZero = i80f48ToNumber(m.lZero);
  const lEff = lZero * Math.sqrt(Math.max(endTs - now, 1));
  const lLast = lZero * Math.sqrt(Math.max(endTs - m.lastAccrualTs.toNumber(), 1));
  const x = i80f48ToNumber(m.reserveYes) * (lEff / lLast);
  const y = i80f48ToNumber(m.reserveNo) * (lEff / lLast);
  return { x, y, lEff, price: priceFromReserves(x, y, lEff) };
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const kp = loadWallet();
  console.log(`wallet  ${kp.publicKey.toBase58()}`);

  await ensureUsdc(conn, kp.publicKey);
  const sol = await ensureSol(conn, kp.publicKey);
  console.log(
    `balance ${(sol / LAMPORTS_PER_SOL).toFixed(3)} SOL · ${await usdcBalance(conn, kp.publicKey)} mUSDC`,
  );

  const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
  const client = PmAmmClient.fromProvider(provider, PROGRAM_ID, USDC_MINT);

  // Markets need a duration of at least 300 s (enforced on-chain).
  const { marketId, marketPda } = await client.send.createMarket({
    name: `Quickstart ${new Date().toISOString().slice(0, 16)}`, // name: 1..64 bytes
    durationSecs: 3600,
    initialPriceBps: 5000, // 50% YES
    depositUsdc: 50, // human units
  });
  const market = new PublicKey(marketPda);
  console.log(`market  ${marketPda}`);

  let m = await client.fetchMarket(market);
  const before = marketState(m);
  console.log(`YES     ${(before.price * 100).toFixed(2)}%`);

  // Buy YES with 5 mUSDC. swap() takes RAW 6-dp units. The 2% fee comes off the
  // USDC leg and estimateSwapOutput is fee-unaware, so quote on 98% of the input
  // and accept 1% slippage on top.
  const amountIn = 5_000_000;
  const { output } = estimateSwapOutput(before.x, before.y, before.lEff, amountIn * 0.98, "yes");
  const minOut = Math.floor(output * 0.99);
  await client.send.swap(market, "usdcToYes", amountIn, minOut);

  await sleep(1000);
  m = await client.fetchMarket(market);
  const yes = await conn.getTokenAccountBalance(
    getAssociatedTokenAddressSync(client.yesMint(market), kp.publicKey),
  );
  console.log(
    `bought  ${yes.value.uiAmountString} YES for 5 mUSDC → YES now ${(marketState(m).price * 100).toFixed(2)}%`,
  );
  console.log(
    `\nopen it: ${APP}/market/${marketId}   (the app routes by numeric marketId, not the PDA)`,
  );
  console.log(
    `you are this market's authority: resolve it after it ends with client.send.resolveMarket(market, "yes" | "no")`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
