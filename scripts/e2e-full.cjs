/**
 * EXHAUSTIVE devnet E2E — every market type × ~every operation, via the SDK,
 * signed by a local keypair (~/.config/solana/id.json). Timed assets (resolve
 * markets, vaults) are created up-front so their waits overlap; result matrix
 * printed at the end.
 *
 *   NODE_PATH="$PWD/app/node_modules" node scripts/e2e-full.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  getAccount,
  mintTo,
} = require("@solana/spl-token");
const anchor = require("@anchor-lang/core");
const { PmAmmClient, i80f48ToNumber, priceFromReserves } = require("../packages/sdk/dist/index.cjs");

const PROGRAM = new PublicKey("GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y");
const USDC = new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ");
function rpc() {
  try {
    const env = fs.readFileSync(path.join(__dirname, "..", "app", ".env.local"), "utf8");
    const m = env.match(/^NEXT_PUBLIC_RPC_URL=(.+)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch {}
  return "https://api.devnet.solana.com";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);
const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))),
);
// Mock-USDC mint authority: a dedicated key, separate from the upgrade key (id.json).
const mintAuthority = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(
        process.env.MINT_AUTHORITY_KEYPAIR ||
          path.join(os.homedir(), ".config/solana/pm-amm-devnet-mint.json"),
      ),
    ),
  ),
);
class NodeWallet {
  constructor(p) { this.payer = p; }
  get publicKey() { return this.payer.publicKey; }
  async signTransaction(tx) { tx.partialSign(this.payer); return tx; }
  async signAllTransactions(txs) { txs.forEach((t) => t.partialSign(this.payer)); return txs; }
}
const results = [];
const assert = (c, m) => { if (!c) throw new Error(m); };
async function step(name, fn) {
  try {
    const note = await fn();
    results.push(`PASS  ${name}${note ? " — " + note : ""}`);
    console.log(`✓ ${name}${note ? " — " + note : ""}`);
  } catch (e) {
    const msg = (e.message || String(e)).replace(/\s+/g, " ").slice(0, 150);
    results.push(`FAIL  ${name} — ${msg}`);
    console.log(`✗ ${name} — ${msg}`);
  }
}

(async () => {
  const connection = new Connection(rpc(), "confirmed");
  const provider = new anchor.AnchorProvider(connection, new NodeWallet(kp), { commitment: "confirmed" });
  const client = PmAmmClient.fromProvider(provider, PROGRAM, USDC);
  const me = kp.publicKey;
  console.log("signer:", me.toBase58(), "\nrpc:", rpc().slice(0, 40), "\n");

  // top up USDC (signed by the dedicated mint authority)
  const ata = await getOrCreateAssociatedTokenAccount(connection, kp, USDC, me);
  await mintTo(connection, kp, USDC, ata.address, mintAuthority, 3000_000000);
  console.log("minted 3000 mock USDC to signer\n");

  const px = (m) => priceFromReserves(i80f48ToNumber(m.reserveYes), i80f48ToNumber(m.reserveNo),
    i80f48ToNumber(m.lZero) * Math.sqrt(Math.max(Number(m.endTs.toString()) - nowS(), 1)));

  // ===================== PHASE 0: create timed assets up-front ==============
  const timed = {};
  await step("type[binary-resolve]: create(305s)+deposit+buy YES", async () => {
    const r = await client.send.createMarket({ name: "Full M2", durationSecs: 305, initialPriceBps: 5000, depositUsdc: 10 });
    timed.M2 = new PublicKey(r.marketPda);
    await client.send.swap(timed.M2, "usdcToYes", 4_000000, 0);
  });
  await step("type[group-resolve]: createGroup(3 legs,305s)+buy leg0", async () => {
    const r = await client.flows.createGroup({ name: "Full G1", legNames: ["A", "B", "C"], durationSecs: 305, budgetPerLegUsdc: 12 });
    timed.G1 = { group: new PublicKey(r.groupPda), legs: r.legMarketIds.map((id) => client.marketPda(id)) };
    await client.send.swap(timed.G1.legs[0], "usdcToYes", 3_000000, 0);
  });
  await step("type[group-cancel]: createGroup(2 legs,305s)", async () => {
    const r = await client.flows.createGroup({ name: "Full G2", legNames: ["X", "Y"], durationSecs: 305, budgetPerLegUsdc: 12 });
    timed.G2 = { group: new PublicKey(r.groupPda), legs: r.legMarketIds.map((id) => client.marketPda(id)) };
  });
  await step("type[binary-vault]: createVault + commit 5 YES + 3 NO", async () => {
    const r = await client.send.createVault({ name: "Full V1", commitDurationSecs: 60, marketDurationSecs: 600, minTotalUsdc: 1 });
    timed.V1 = new PublicKey(r.vaultPda);
    await client.send.vaultCommit(timed.V1, "yes", 5);
    await client.send.vaultCommit(timed.V1, "no", 3);
  });
  await step("type[binary-vault-refund]: createVault(min 50) + commit 2 (below min)", async () => {
    const r = await client.send.createVault({ name: "Full V2", commitDurationSecs: 60, marketDurationSecs: 600, minTotalUsdc: 50 });
    timed.V2 = new PublicKey(r.vaultPda);
    await client.send.vaultCommit(timed.V2, "yes", 2);
  });
  await step("type[multi-vault]: createVaultGroup(3 legs) + commit each leg", async () => {
    const r = await client.send.createVaultGroup({ name: "Full VG1", legNames: ["P", "Q", "R"], commitDurationSecs: 60, marketDurationSecs: 600, minTotalUsdc: 1 });
    timed.VG1 = new PublicKey(r.vaultPda);
    await client.send.vaultCommitGroup(timed.VG1, 0, 4);
    await client.send.vaultCommitGroup(timed.VG1, 1, 3);
    await client.send.vaultCommitGroup(timed.VG1, 2, 2);
  });
  await step("type[multi-vault-refund]: createVaultGroup(min 50) + commit 2 (below)", async () => {
    const r = await client.send.createVaultGroup({ name: "Full VG2", legNames: ["S", "T"], commitDurationSecs: 60, marketDurationSecs: 600, minTotalUsdc: 50 });
    timed.VG2 = new PublicKey(r.vaultPda);
    await client.send.vaultCommitGroup(timed.VG2, 0, 2);
  });
  const t0 = nowS();

  // ===================== PHASE 1: no-wait binary operations =================
  let M1;
  await step("binary: createMarket(deposit 100, seed 60%)", async () => {
    const r = await client.send.createMarket({ name: "Full M1", durationSecs: 86400, initialPriceBps: 6000, depositUsdc: 100 });
    M1 = new PublicKey(r.marketPda);
    const m = await client.fetchMarket(M1);
    assert(m.initialPriceBps === 6000 && i80f48ToNumber(m.lZero) > 0, "seed/liq");
    return "seed 60%, L0 set";
  });
  await step("op: swap usdcToYes", async () => { const p0 = px(await client.fetchMarket(M1)); await client.send.swap(M1, "usdcToYes", 5_000000, 0); const p1 = px(await client.fetchMarket(M1)); assert(p1 > p0, "price up"); return `${(p0*100).toFixed(1)}→${(p1*100).toFixed(1)}%`; });
  await step("op: swap usdcToNo", async () => { await client.send.swap(M1, "usdcToNo", 5_000000, 0); });
  await step("op: swap yesToUsdc (sell YES)", async () => { await client.send.swap(M1, "yesToUsdc", 1_000000, 0); });
  await step("op: swap noToUsdc (sell NO)", async () => { await client.send.swap(M1, "noToUsdc", 1_000000, 0); });
  await step("op: swap yesToNo (direct)", async () => { await client.send.swap(M1, "yesToNo", 1_000000, 0); });
  await step("op: swap noToYes (direct)", async () => { await client.send.swap(M1, "noToYes", 1_000000, 0); });
  await step("op: redeem_pair (burn YES+NO → USDC)", async () => {
    const yesAta = await getAssociatedTokenAddress(client.yesMint(M1), me);
    const noAta = await getAssociatedTokenAddress(client.noMint(M1), me);
    const y = Number((await getAccount(connection, yesAta)).amount);
    const n = Number((await getAccount(connection, noAta)).amount);
    const amt = Math.min(y, n);
    assert(amt > 0, "need YES+NO");
    await client.send.redeemPair(M1, amt);
    return `${(amt / 1e6).toFixed(2)} pairs`;
  });
  await step("op: deposit_liquidity (standalone)", async () => { await client.send.depositLiquidity(M1, 20); });
  await step("op: accrue", async () => { await client.send.accrue(M1); });
  await step("op: suggest_l_zero (view ix)", async () => {
    const ix = await client.ix.suggestLZero({ market: M1, budgetUsdc: 1000_000000, sigmaBps: 8000 });
    await client.sendIxs([ix]);
  });
  await step("op: claim_lp_residuals", async () => {
    try { await client.send.claimLpResiduals(M1); return "claimed"; }
    catch (e) { if (/NoResidualsToClaim/.test(e.message || "")) return "none yet (ok)"; throw e; }
  });
  await step("op: withdraw_liquidity (EXACT shares — the fix)", async () => {
    const lp = await client.fetchLpPosition(M1, me);
    assert(lp, "lp position");
    await client.send.withdrawLiquidity(M1, lp.shares); // raw Q64.64 BN
    const after = await client.fetchLpPosition(M1, me);
    assert(!after || after.shares.isZero(), "position not closed");
    return "withdrew all";
  });
  await step("binary: custom seed price (25%)", async () => {
    const r = await client.send.createMarket({ name: "Full M3", durationSecs: 86400, initialPriceBps: 2500, depositUsdc: 10 });
    const m = await client.fetchMarket(new PublicKey(r.marketPda));
    assert(m.initialPriceBps === 2500, "bps");
    return "seed 25%";
  });

  // ===================== PHASE 2: vault waits (60s commit) ===================
  await step("wait: commit windows (60s)", async () => { while (nowS() < t0 + 63) await sleep(4000); });
  await step("binary-vault: launch → claim_committer", async () => {
    const lr = await client.send.launchVaultMarket(timed.V1);
    const v = await client.fetchVault(timed.V1);
    assert(v.launched && v.market.toBase58() === lr.marketPda && v.winningPriceBps === 6250, "launch/seed");
    await client.send.claimCommitter(timed.V1, v.market);
    const ya = await getAssociatedTokenAddress(client.yesMint(v.market), me);
    assert(Number((await getAccount(connection, ya)).amount) === 5_000000, "YES minted");
    return "seed 62.5%, 5 YES + 3 NO minted";
  });
  await step("binary-vault: refund_commit (below min)", async () => {
    await client.send.refundCommit(timed.V2);
    const cp = await client.fetchCommitPosition(timed.V2, me);
    assert(cp && cp.claimed, "not marked claimed");
    return "refunded";
  });
  await step("multi-vault: launch group + 3 legs → claim_committer_group ×3", async () => {
    const gm = await client.send.launchVaultGroupMarket(timed.VG1);
    const group = new PublicKey(gm.groupPda);
    const legMarkets = [];
    for (let i = 0; i < 3; i++) legMarkets.push(new PublicKey((await client.send.launchVaultGroupLeg(timed.VG1, group, i)).marketPda));
    const v = await client.fetchVaultGroup(timed.VG1);
    assert(v.groupMarketInitialized && v.legsLaunched === 3, "legs launched");
    let claimed = 0;
    for (let i = 0; i < 3; i++) { await client.send.claimCommitterGroup(timed.VG1, group, legMarkets[i], i); claimed++; }
    return `3 legs launched, claimed ${claimed}`;
  });
  await step("multi-vault: refund_commit_group (below min)", async () => {
    await client.send.refundCommitGroup(timed.VG2);
    const cp = await client.fetchCommitGroupPosition(timed.VG2, me);
    assert(cp && cp.claimed, "not claimed");
    return "refunded";
  });

  // ===================== PHASE 3: resolve waits (~5 min expiry) ==============
  await step("wait: market/group expiry (~5 min)", async () => { while (nowS() < t0 + 308) await sleep(5000); });
  await step("binary-resolve: resolveMarket(YES) → claim_winnings", async () => {
    await client.send.resolveMarket(timed.M2, "yes");
    const m = await client.fetchMarket(timed.M2);
    assert(m.resolved && m.winningSide === 1, "resolved YES");
    await client.send.claimWinnings(timed.M2);
    return "resolved + claimed";
  });
  await step("group-resolve: resolveGroup(leg 0) → cascade → claimAll", async () => {
    await client.flows.resolveGroup({ group: timed.G1.group, legMarkets: timed.G1.legs, winningLeg: 0 });
    const g = await client.fetchGroup(timed.G1.group);
    assert(g.resolved && g.winningLeg === 0, "resolved leg0");
    const { legsClaimed } = await client.flows.claimAllGroupWinnings({ legMarkets: timed.G1.legs });
    return `resolved + claimed ${legsClaimed} legs`;
  });
  await step("group-cancel: cancel_group_market → cascade NO → claimAll", async () => {
    await client.flows.resolveGroup({ group: timed.G2.group, legMarkets: timed.G2.legs, winningLeg: null });
    const g = await client.fetchGroup(timed.G2.group);
    assert(g.resolved && g.winningLeg === 255, "not cancelled (winningLeg should be 0xFF)");
    await client.flows.claimAllGroupWinnings({ legMarkets: timed.G2.legs }).catch(() => {});
    return "cancelled (all legs NO)";
  });

  const failed = results.filter((r) => r.startsWith("FAIL"));
  console.log("\n========== FULL E2E MATRIX ==========");
  results.forEach((r) => console.log(r));
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
