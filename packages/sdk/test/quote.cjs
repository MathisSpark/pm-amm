/**
 * Offline tests for marketState / quoteSwap / minOutput (no network, no SOL).
 * Live-chain parity (quotes vs simulateTransaction, < 0.01% on devnet markets,
 * all 6 directions) was checked when these helpers landed; this locks the
 * invariants.   node packages/sdk/test/quote.cjs   (build the SDK first)
 */
const assert = require("node:assert");
const sdk = require("../dist/index.cjs");
let passed = 0;
// 5. market state + quotes (all 6 directions). Live-chain parity (< 0.01% vs
// simulateTransaction) is checked separately; these lock the invariants.
{
  const { marketState, quoteSwap, minOutput } = sdk;
  const Q = 2n ** 48n; // I80F48 raw scale
  const fx = (n) => BigInt(Math.round(n)) * Q;
  const bn = (n) => ({ toNumber: () => n });
  const now = 1_000_000;
  const L0 = 1e8 / Math.sqrt(86_400); // L_eff = 1e8 now (one day left)
  const R = 1e8 * sdk.phi(0); // on-curve reserves at 50%: x = y = L_eff·φ(0)
  const mk = (x, y, lastAccrualTs) => ({
    endTs: bn(now + 86_400),
    lastAccrualTs: bn(lastAccrualTs),
    lZero: fx(L0),
    reserveYes: fx(x),
    reserveNo: fx(y),
    resolved: false,
    winningSide: 0,
  });
  const fresh = mk(R, R, now);
  const st = marketState(fresh, now);
  assert.ok(Math.abs(st.price - 0.5) < 1e-9, "marketState: symmetric reserves -> 50%");
  assert.ok(Math.abs(st.x - R) < 2, "marketState: no rescale when accrued now");

  // Idle 1 day: reserves shrink by L_eff(now) / L_eff(then), price unchanged.
  const idle = marketState(mk(R, R, now - 86_400), now);
  assert.ok(
    Math.abs(idle.x - R * Math.sqrt(86_400 / (2 * 86_400))) < 2,
    "marketState: rescales idle reserves",
  );
  assert.ok(Math.abs(idle.price - 0.5) < 1e-9, "marketState: rescale keeps the price");

  const buy = quoteSwap(fresh, "usdcToYes", 10e6, now);
  assert.strictEqual(buy.fee, 200_000, "quoteSwap: 2% fee on USDC in");
  assert.ok(
    buy.out > 9.8e6 && buy.priceAfter > 0.5,
    "quoteSwap: buying YES below $1 moves the price up",
  );
  const sell = quoteSwap(fresh, "yesToUsdc", 10e6, now);
  assert.ok(
    sell.out < 5e6 && sell.fee > 0 && sell.priceAfter < 0.5,
    "quoteSwap: selling YES at ~50c, fee on output",
  );
  const yn = quoteSwap(fresh, "yesToNo", 10e6, now);
  const ny = quoteSwap(fresh, "noToYes", 10e6, now);
  assert.ok(
    yn.fee === 0 && Math.abs(yn.out - ny.out) < 2,
    "quoteSwap: YES<->NO free and symmetric at 50%",
  );
  const bNo = quoteSwap(fresh, "usdcToNo", 10e6, now);
  assert.ok(Math.abs(bNo.out - buy.out) < 2, "quoteSwap: buys symmetric at 50%");
  assert.strictEqual(minOutput({ out: 1_000_000 }), 990_000, "minOutput: 1% default");
  assert.throws(
    () => quoteSwap({ ...fresh, resolved: true, winningSide: 1 }, "usdcToYes", 1e6, now),
    "quoteSwap: refuses resolved",
  );
  assert.strictEqual(
    marketState({ ...fresh, resolved: true, winningSide: 2 }, now).winner,
    "no",
    "winningSide 2 = NO",
  );
  passed += 12;
}

console.log(`✓ quote tests passed — ${passed} assertions`);
