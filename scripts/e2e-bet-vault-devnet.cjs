/**
 * Devnet smoke test for Bet Vault v2 + the entry-side surplus fix.
 * Alice 70 YES / Bob 30 NO, lp_bps = 5000, Carol buys 20 USDC of YES, YES wins.
 * Expect: Alice ≈ 94, Bob 0, Carol > 20, market vault ≈ 0 after every claim.
 *
 * Takes ~7 min (real devnet clock: 60 s commit window + 345 s market). Funds
 * three throwaway wallets from ~/.config/solana/id.json (needs ~1 SOL of devnet
 * SOL); mUSDC is minted by the dedicated mint authority
 * (~/.config/solana/pm-amm-devnet-mint.json, override with MINT_AUTHORITY_KEYPAIR).
 *
 *   pnpm run build:sdk
 *   NODE_PATH=packages/sdk/node_modules node scripts/e2e-bet-vault-devnet.cjs
 */
const fs = require("fs");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } = require("@solana/web3.js");
const { getAccount, getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, mintTo } = require("@solana/spl-token");
const anchor = require("@anchor-lang/core");
const { PmAmmClient } = require("../packages/sdk/dist/index.cjs");

const RPC = "https://api.devnet.solana.com";
const PROGRAM = new PublicKey("GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y");
const USDC = new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ");
const COMMIT_SECS = 60;
const MARKET_SECS = 345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The public devnet RPC rate-limits hard: retry everything with backoff. */
async function retry(label, fn, tries = 6) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const msg = String(e?.message || e);
      if (i >= tries || !/429|Too Many Requests|rate limit|block height exceeded|Blockhash not found/i.test(msg)) throw e;
      console.log(`  retry ${i}/${tries} on ${label}: ${msg.slice(0, 80)}`);
      await sleep(4000 * i);
    }
  }
}
const usd = (raw) => (Number(raw) / 1e6).toFixed(4);

class NodeWallet {
  constructor(p) { this.payer = p; }
  get publicKey() { return this.payer.publicKey; }
  async signTransaction(tx) { tx.partialSign(this.payer); return tx; }
  async signAllTransactions(txs) { txs.forEach((t) => t.partialSign(this.payer)); return txs; }
}

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`))));
  const mintAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.MINT_AUTHORITY_KEYPAIR || `${process.env.HOME}/.config/solana/pm-amm-devnet-mint.json`))));
  const mk = async (name, usdcAmount) => {
    const kp = Keypair.generate();
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: 0.25 * LAMPORTS_PER_SOL }));
    await conn.sendTransaction(tx, [funder]).then((s) => conn.confirmTransaction(s, "confirmed"));
    const ata = (await getOrCreateAssociatedTokenAccount(conn, funder, USDC, kp.publicKey)).address;
    await mintTo(conn, funder, USDC, ata, mintAuthority, usdcAmount * 1e6);
    const client = PmAmmClient.fromProvider(new anchor.AnchorProvider(conn, new NodeWallet(kp), { commitment: "confirmed" }), PROGRAM, USDC);
    return { name, kp, ata, client };
  };
  const bal = async (a) => { try { return Number((await getAccount(conn, a)).amount); } catch { return 0; } };

  console.log("funding Alice / Bob / Carol…");
  const alice = await retry("fund Alice", () => mk("Alice", 200));
  await sleep(1500);
  const bob = await retry("fund Bob", () => mk("Bob", 200));
  await sleep(1500);
  const carol = await retry("fund Carol", () => mk("Carol", 200));
  const start = {};
  for (const u of [alice, bob, carol]) start[u.name] = await bal(u.ata);

  const { betVaultPda } = await retry("createBetVault", () => alice.client.send.createBetVault({
    name: "Devnet bet vault v2", commitDurationSecs: COMMIT_SECS, marketDurationSecs: MARKET_SECS,
    minTotal: 1, lpBps: 5000,
  }));
  const vault = new PublicKey(betVaultPda);
  console.log("bet vault:", betVaultPda);
  await retry("commit Alice", () => alice.client.send.betCommit(vault, "yes", 70));
  await sleep(1500);
  await retry("commit Bob", () => bob.client.send.betCommit(vault, "no", 30));
  console.log("commits: Alice 70 YES, Bob 30 NO");

  const v0 = await alice.client.fetchBetVault(vault);
  console.log(`waiting ${COMMIT_SECS}s for the commit window…`);
  await sleep((COMMIT_SECS + 3) * 1000);

  const { marketPda } = await retry("launch", () => alice.client.send.launchBetVault(vault));
  const market = new PublicKey(marketPda);
  const v1 = await alice.client.fetchBetVault(vault);
  const m1 = await alice.client.fetchMarket(market);
  const marketVault = alice.client.marketVault(market);
  console.log(`launched ${marketPda} at ${v1.priceBps} bps (lp ${v1.effectiveLpBps} bps)`);
  console.log(`  market.authority is the vault PDA: ${m1.authority.equals(vault)}`);
  console.log(`  kept in vault: ${usd(await bal(alice.client.betVaultCollateral(vault, USDC)))} | as liquidity: ${usd(await bal(marketVault))}`);
  console.log(`  LP surplus credited: excess_yes=${usd((await alice.client.fetchLpPosition(market, vault)).excessYes)}`);

  await retry("swap", () => carol.client.send.swap(market, "usdcToYes", 20_000_000, 0));
  const carolYes = await bal(await getAssociatedTokenAddress(alice.client.yesMint(market), carol.kp.publicKey));
  console.log(`Carol bought ${usd(carolYes)} YES for 20 USDC`);

  const endTs = Number(m1.endTs.toString());
  const waitMs = Math.max(0, (endTs - Math.floor(Date.now() / 1000) + 5) * 1000);
  console.log(`waiting ${Math.round(waitMs / 1000)}s for expiry…`);
  await sleep(waitMs);

  await retry("resolve", () => alice.client.send.resolveBetVault(vault, "yes"));
  await sleep(1500);
  await retry("settle", () => alice.client.send.settleBetVault(vault));
  await sleep(1500);
  const v2 = await alice.client.fetchBetVault(vault);
  console.log(`settled: payout pool ${usd(v2.payoutPool)} (winning side: ${v2.winningSide === 1 ? "YES" : "NO"})`);

  await retry("claim Alice", () => alice.client.send.claimBet(vault));
  await sleep(1500);
  await retry("claim Bob", () => bob.client.send.claimBet(vault));
  await sleep(1500);
  await retry("claim Carol", () => carol.client.send.claimWinnings(market));

  console.log("\n=== RESULT (YES won) ===");
  for (const [u, staked] of [[alice, 70], [bob, 30], [carol, 20]]) {
    const net = (await bal(u.ata)) - start[u.name];
    console.log(`  ${u.name.padEnd(6)} staked ${staked} -> net ${net >= 0 ? "+" : ""}${usd(net)} USDC`);
  }
  console.log(`  left in market vault: ${usd(await bal(marketVault))} | left in bet vault: ${usd(await bal(alice.client.betVaultCollateral(vault, USDC)))}`);
  console.log(`  commit window was ${COMMIT_SECS}s, market ${MARKET_SECS}s (vault commit_end=${v0.commitEndTs})`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e?.logs?.join("\n") || e?.message || String(e)); process.exit(1); });
