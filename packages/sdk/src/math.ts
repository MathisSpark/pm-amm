/**
 * Client-side pm-AMM math (float64, for display / off-chain estimation only).
 * Port of oracle/pm_amm_math.py — NOT for on-chain use.
 *
 * Pure module: zero Solana / chain dependencies. Also exposed at the
 * `@pm-amm/sdk/math` subpath so non-Solana consumers can pull it in standalone.
 */

/**
 * Convert an Anchor-deserialized Q64.64 value (BN or bigint) to a JS number.
 *
 * Naively writing `Number(bn) / 2**48` loses precision for any |value| > 2^53
 * because `Number(bn)` truncates the low bits before division. Q64.64 values
 * regularly exceed that range — e.g. `L_0 = 1e9` µUSDC scaled by 2^48 is
 * ~3e23, well above 2^53 ≈ 9e15. Split into integer and fractional parts
 * (using BigInt math) and recombine to keep ~52 bits of precision in the
 * mantissa.
 */
export function i80f48ToNumber(raw: { toString(): string } | bigint): number {
  const bn = typeof raw === "bigint" ? raw : BigInt(raw.toString());
  // BigInt literals (`1n`) need ES2020; use the `BigInt(...)` form to stay
  // compatible with the project's TS target.
  const SCALE = BigInt(1) << BigInt(48);
  // BigInt division truncates toward zero. For negative values, `bn % SCALE`
  // returns a non-positive remainder so intPart + fracPart/2^48 reconstructs
  // the signed magnitude correctly.
  const intPart = bn / SCALE;
  const fracPart = bn % SCALE;
  return Number(intPart) + Number(fracPart) / 2 ** 48;
}

/** Standard normal PDF */
export function phi(z: number): number {
  return Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF (Abramowitz & Stegun approximation) */
export function capitalPhi(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741;
  const a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/** Price from reserves: P = Phi((y - x) / L_eff) */
export function priceFromReserves(x: number, y: number, lEff: number): number {
  return capitalPhi((y - x) / lEff);
}

/** Pool value: V(P) = L_eff * phi(Phi_inv(P)) */
export function poolValue(price: number, lEff: number): number {
  // Approximate Phi_inv for display
  const u = phiInv(price);
  return lEff * phi(u);
}

/** Approximate Phi_inv (Beasley-Springer-Moro) */
function phiInv(p: number): number {
  if (p <= 0.0001) return -3.7;
  if (p >= 0.9999) return 3.7;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/** Format USDC amount (6 decimals) */
export function formatUsdc(lamports: number | bigint): string {
  const val = Number(lamports) / 1e6;
  return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Decimal-aware amount formatter for ANY collateral token. `decimals` is the
 * mint's decimals (6 = USDC, 9 = wSOL, …); optionally append a `symbol`.
 */
export function formatAmount(
  raw: number | bigint,
  decimals: number,
  opts?: { symbol?: string; maxFractionDigits?: number },
): string {
  const val = Number(raw) / 10 ** decimals;
  const maxFrac = opts?.maxFractionDigits ?? Math.min(decimals, 6);
  const s = val.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(2, maxFrac),
    maximumFractionDigits: maxFrac,
  });
  return opts?.symbol ? `${s} ${opts.symbol}` : s;
}

/** Human → raw base units for a mint with `decimals` (1.5 @ 6dp -> 1_500_000). */
export function toRaw(human: number, decimals: number): number {
  return Math.floor(human * 10 ** decimals);
}

/** Raw base units → human number for a mint with `decimals`. */
export function fromRaw(raw: number | bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Format price as percentage */
export function formatPrice(price: number): string {
  return `${(price * 100).toFixed(1)}%`;
}

/** Estimate swap output (client-side, for preview) */
export function estimateSwapOutput(
  reserveYes: number,
  reserveNo: number,
  lEff: number,
  amountIn: number,
  side: "yes" | "no",
): { output: number; priceAfter: number; priceImpact: number } {
  if (lEff <= 0 || amountIn <= 0) {
    return { output: 0, priceAfter: 0.5, priceImpact: 0 };
  }

  const priceBefore = priceFromReserves(reserveYes, reserveNo, lEff);

  // Guard against priceBefore == 0 (degenerate market). `priceImpact` is a
  // *display* metric — show 0 instead of NaN/Infinity when the relative
  // change is undefined.
  const safeImpact = (after: number) =>
    priceBefore > 0 ? Math.abs(after - priceBefore) / priceBefore : 0;

  // USDC->YES: y_new = y + amountIn, find x_new via binary search on u
  // USDC->NO:  x_new = x + amountIn, find y_new via binary search on u
  if (side === "yes") {
    const yNew = reserveNo + amountIn;
    const xNew = findXFromY(yNew, lEff);
    const output = amountIn + (reserveYes - xNew);
    const priceAfter = priceFromReserves(xNew, yNew, lEff);
    return {
      output: Math.max(0, output),
      priceAfter,
      priceImpact: safeImpact(priceAfter),
    };
  } else {
    const xNew = reserveYes + amountIn;
    const yNew = findYFromX(xNew, lEff);
    const output = amountIn + (reserveNo - yNew);
    const priceAfter = priceFromReserves(xNew, yNew, lEff);
    return {
      output: Math.max(0, output),
      priceAfter,
      priceImpact: safeImpact(priceAfter),
    };
  }
}

function findXFromY(yTarget: number, lEff: number): number {
  let lo = -6,
    hi = 6;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const yMid = lEff * (mid * capitalPhi(mid) + phi(mid));
    if (yMid < yTarget) lo = mid;
    else hi = mid;
  }
  const u = (lo + hi) / 2;
  return lEff * (u * capitalPhi(u) + phi(u) - u);
}

function findYFromX(xTarget: number, lEff: number): number {
  let lo = -6,
    hi = 6;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const xMid = lEff * (mid * capitalPhi(mid) + phi(mid) - mid);
    if (xMid > xTarget) lo = mid;
    else hi = mid;
  }
  const u = (lo + hi) / 2;
  return lEff * (u * capitalPhi(u) + phi(u));
}

// ============================================================================
// LP Simulation — Paper section 7 & 8
// ============================================================================

/** Expected daily LVR = V(P) / (2 * T_remaining_days). Paper section 8. */
export function expectedDailyLvr(price: number, lEff: number, remainingSecs: number): number {
  if (remainingSecs <= 0) return 0;
  const v = poolValue(price, lEff);
  return v / ((2 * remainingSecs) / 86400);
}

/** Terminal wealth expectation: E[W_T] = W_0 / 2. Paper section 8. */
export function expectedTerminalWealth(deposited: number): number {
  return deposited / 2;
}

/**
 * Simulate LP deposit: compute shares received and resulting pool share.
 * Returns { newShares, poolSharePct, newLEff, newPoolValue }.
 */
export function simulateLpDeposit(
  amount: number,
  price: number,
  lEff: number,
  totalShares: number,
  remainingSecs: number,
  lZero: number,
): { newShares: number; poolSharePct: number; newPoolValue: number; estDailyYield: number } {
  if (totalShares <= 0 || lEff <= 0) {
    // First deposit: shares = amount, pool value = amount at P=0.5
    return {
      newShares: amount,
      poolSharePct: 100,
      newPoolValue: amount,
      estDailyYield: remainingSecs > 0 ? amount / ((2 * remainingSecs) / 86400) : 0,
    };
  }

  if (lZero <= 0) return { newShares: 0, poolSharePct: 0, newPoolValue: 0, estDailyYield: 0 };

  // Fix #1 (full collateralization): a follow-up deposit adds L_eff for
  // `amount` at the worst-case side (max(x, y) = amount), matching
  // deposit_liquidity on-chain. The vault always covers the bigger side, so
  // this mirrors that calibration, not V(P). Shares are minted in proportion
  // to the L added (L_eff and L_0 scale together), not 1 per USDC.
  const u = phiInv(price);
  const pu = phi(u);
  const cY = u * price + pu; // y reserve coefficient
  const cX = cY - u; // x reserve coefficient
  const cMax = Math.max(cX, cY);
  if (cMax <= 0) return { newShares: 0, poolSharePct: 0, newPoolValue: 0, estDailyYield: 0 };

  // L_eff added by the deposit: amount / cMax (L_0 is linear in budget).
  const lEffIncrement = amount / cMax;
  const newShares = (totalShares * lEffIncrement) / lEff;
  const newTotal = totalShares + newShares;
  const poolSharePct = (newShares / newTotal) * 100;

  const newLEff = lEff + lEffIncrement;
  const newPoolValue = poolValue(price, newLEff);

  const estDailyYield =
    remainingSecs > 0 ? (newPoolValue * poolSharePct) / 100 / ((2 * remainingSecs) / 86400) : 0;

  return { newShares, poolSharePct, newPoolValue, estDailyYield };
}

/**
 * Compute current LP position P&L.
 * Includes pool share value + pending residuals (unclaimed dC_t) + claimed tokens in wallet.
 *
 * Pending residuals = (cumPerShare - checkpoint) * shares (still in the contract)
 * Claimed tokens = YES/NO already in the user's wallet
 */
export function lpPositionPnl(
  shares: number,
  totalShares: number,
  deposited: number,
  price: number,
  lEff: number,
  // Pending residuals from on-chain state
  cumYesPerShare: number = 0,
  cumNoPerShare: number = 0,
  yesCheckpoint: number = 0,
  noCheckpoint: number = 0,
  // Already claimed tokens in wallet
  walletYes: number = 0,
  walletNo: number = 0,
  // Current pool reserves (needed to project resolution payout)
  reserveYes: number = 0,
  reserveNo: number = 0,
): LpPnlResult {
  const empty: LpPnlResult = {
    currentValue: 0,
    pnl: 0,
    pnlPct: 0,
    poolSharePct: 0,
    poolValue: 0,
    residualsValue: 0,
    totalYes: 0,
    totalNo: 0,
    ifYesWins: 0,
    ifNoWins: 0,
  };
  if (totalShares <= 0 || shares <= 0) return empty;

  const frac = shares / totalShares;
  const poolSharePct = frac * 100;
  const totalPV = poolValue(price, lEff);
  const myPoolValue = totalPV * frac;

  // Pending (unclaimed) residuals from dC_t
  const pendingYes = Math.max(0, (cumYesPerShare - yesCheckpoint) * shares);
  const pendingNo = Math.max(0, (cumNoPerShare - noCheckpoint) * shares);

  // Total tokens the LP has now (pending + wallet)
  const tokensYes = pendingYes + walletYes;
  const tokensNo = pendingNo + walletNo;

  // At resolution: pool reserves also drain to LPs as residuals
  // LP's share of the current reserves will ALSO be distributed
  const futureYes = reserveYes * frac;
  const futureNo = reserveNo * frac;

  // Total YES/NO the LP will have at expiry (current + future from pool)
  const totalYes = tokensYes + futureYes;
  const totalNo = tokensNo + futureNo;

  // Current value using market price (includes pool value which will become residuals)
  const currentValue = myPoolValue + (tokensYes * price + tokensNo * (1 - price));
  const pnl = currentValue - deposited;
  const pnlPct = deposited > 0 ? (pnl / deposited) * 100 : 0;
  const residualsValue = tokensYes * price + tokensNo * (1 - price);

  // Resolution scenarios: all reserves distributed, each winning token = 1 USDC
  const ifYesWins = totalYes; // all YES tokens worth 1 USDC each
  const ifNoWins = totalNo; // all NO tokens worth 1 USDC each

  return {
    currentValue,
    pnl,
    pnlPct,
    poolSharePct,
    poolValue: myPoolValue,
    residualsValue,
    totalYes,
    totalNo,
    ifYesWins,
    ifNoWins,
  };
}

export interface LpPnlResult {
  currentValue: number;
  pnl: number;
  pnlPct: number;
  poolSharePct: number;
  poolValue: number;
  residualsValue: number;
  totalYes: number;
  totalNo: number;
  ifYesWins: number;
  ifNoWins: number;
}

/** Phi_inv exported for LP simulations */
export { phiInv };

// ============================================================================
// Multi-outcome (GroupMarket) helpers
//
// Mirror of the Rust GroupMarket math in state.rs. For display + client-side
// validation only — the on-chain program enforces these invariants.
// ============================================================================

/**
 * Seed price for each leg of an N-leg group, in basis points.
 * Matches Rust: GroupMarket::expected_leg_initial_price_bps().
 * Floor division — residual (< N bps) absorbed by the off-chain dispatcher.
 */
export function expectedLegSeedBps(legCount: number): number {
  if (legCount <= 0) return 0;
  return Math.floor(10_000 / legCount);
}

/** Same as above, returned as a probability (0..1). */
export function expectedLegSeedPrice(legCount: number): number {
  return expectedLegSeedBps(legCount) / 10_000;
}

/** Σ p_i — sum of YES probabilities across all legs of a group. */
export function sumProbabilities(prices: number[]): number {
  return prices.reduce((acc, p) => acc + p, 0);
}

/**
 * |Σ - 1| in percentage points. Useful as a "house health" indicator —
 * the off-chain arb daemon should keep this near 0.
 * Returns 0 if there are no prices.
 */
export function groupDriftPct(prices: number[]): number {
  if (prices.length === 0) return 0;
  const s = sumProbabilities(prices);
  return Math.abs(s - 1) * 100;
}

/**
 * Split a total USDC budget equally across N legs (in micro-USDC, 6 decimals).
 * Floor split; residual goes to leg 0 so Σ allocations = totalLamports exactly.
 */
export function legBudgetAllocations(legCount: number, totalLamports: number): number[] {
  if (legCount <= 0) return [];
  const base = Math.floor(totalLamports / legCount);
  const residual = totalLamports - base * legCount;
  const out = new Array(legCount).fill(base);
  if (out.length > 0) out[0] += residual;
  return out;
}

/**
 * If user bets `betUsd` on a single leg of a group, by how many percentage
 * points does Σ p_i drift? Approximation using estimateSwapOutput on that
 * leg in isolation. Off-chain — informational, not authoritative.
 */
export function expectedDriftAfterBet(
  legReserveYes: number,
  legReserveNo: number,
  legLEff: number,
  betUsd: number,
  side: "yes" | "no" = "yes",
): number {
  if (legLEff <= 0 || betUsd <= 0) return 0;
  const before = priceFromReserves(legReserveYes, legReserveNo, legLEff);
  const sim = estimateSwapOutput(legReserveYes, legReserveNo, legLEff, betUsd, side);
  const after = sim.priceAfter;
  return Math.abs(after - before);
}

/** Format time remaining */
export function formatTimeRemaining(endTs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const remaining = endTs - now;
  if (remaining <= 0) return "Expired";
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((remaining % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// ----------------------------------------------------------------------------
// Bet Vault v2 — pure mirrors of the on-chain rules, for previews in the UI
// ----------------------------------------------------------------------------

/** Odds implied by the stakes, in bps of YES (the launch price). */
export function betOddsBps(yesTotal: number, noTotal: number): number {
  const total = yesTotal + noTotal;
  return total > 0 ? Math.floor((yesTotal * 10_000) / total) : 0;
}

/**
 * Share of the pot actually deposited as liquidity at launch: `lpBps` capped at
 * the favourite's stake share (`BetVault::effective_lp_bps`). The cap is what
 * guarantees a winner never receives less than they staked.
 */
export function betEffectiveLpBps(yesTotal: number, noTotal: number, lpBps: number): number {
  const p = betOddsBps(yesTotal, noTotal);
  return Math.min(lpBps, Math.max(p, 10_000 - p));
}

/**
 * Collateral kept out of the AMM — the floor the winning side always shares,
 * whatever outside traders do. Show it as the "guaranteed minimum".
 */
export function betKeptCollateral(yesTotal: number, noTotal: number, lpBps: number): number {
  const total = BigInt(Math.floor(yesTotal + noTotal));
  const kept = BigInt(10_000 - betEffectiveLpBps(yesTotal, noTotal, lpBps));
  return Number((total * kept) / 10_000n); // BigInt: raw × bps overflows float64
}

/**
 * A stake's slice of a settled pool: `pool × stake / basis`, where `basis` is
 * the winning side's total (or every stake once the vault is voided). On-chain
 * the claim that completes `basis` also sweeps the rounding dust, so the last
 * claimer can get a lamport or two more than this.
 */
export function betPayout(pool: number, stake: number, basis: number): number {
  if (basis <= 0) return 0;
  // BigInt: pool × stake in raw units blows past float64's exact range.
  return Number((BigInt(Math.floor(pool)) * BigInt(Math.floor(stake))) / BigInt(Math.floor(basis)));
}

// ============================================================================
// Market state & exact swap quotes (all 6 directions, fee included)
// ============================================================================

/**
 * The market fields the quote math needs. Structural, so a decoded
 * `MarketAccount` (BN fields) or any `{ toNumber(), toString() }` works.
 */
export interface MarketLike {
  endTs: { toNumber(): number };
  lastAccrualTs: { toNumber(): number };
  lZero: { toString(): string } | bigint;
  reserveYes: { toString(): string } | bigint;
  reserveNo: { toString(): string } | bigint;
  resolved: boolean;
  winningSide: number;
}

export interface MarketState {
  /** YES / NO reserves rescaled to `now` (raw 6-dp units). */
  x: number;
  y: number;
  lEff: number;
  /** YES price in [0, 1]; 1 or 0 once resolved. */
  price: number;
  secondsLeft: number;
  expired: boolean;
  resolved: boolean;
  /** From `Market.winningSide`: 0 = unresolved, 1 = YES, 2 = NO. */
  winner: "yes" | "no" | null;
}

const nowSecs = () => Math.floor(Date.now() / 1000);

/**
 * A market's state as the program sees it at `now`.
 *
 * Stored reserves date from `lastAccrualTs`, and every swap accrues first
 * (L_eff = L_0·√(T−t) shrinks, and reserves with it). Pairing stored reserves
 * with today's L_eff over-promises swap output (+15–87% measured on devnet
 * markets idle ~27 h), so they are rescaled by L_eff(now) / L_eff(lastAccrual).
 */
export function marketState(m: MarketLike, now = nowSecs()): MarketState {
  const endTs = m.endTs.toNumber();
  const lZero = i80f48ToNumber(m.lZero);
  const secondsLeft = Math.max(endTs - now, 0);
  const lEff = lZero * Math.sqrt(Math.max(endTs - now, 1));
  const lLast = lZero * Math.sqrt(Math.max(endTs - m.lastAccrualTs.toNumber(), 1));
  const scale = lLast > 0 ? lEff / lLast : 0;
  const x = i80f48ToNumber(m.reserveYes) * scale;
  const y = i80f48ToNumber(m.reserveNo) * scale;
  const winner = m.winningSide === 1 ? "yes" : m.winningSide === 2 ? "no" : null;
  const price = winner ? (winner === "yes" ? 1 : 0) : lEff > 0 ? capitalPhi((y - x) / lEff) : 0.5;
  return {
    x,
    y,
    lEff,
    price,
    secondsLeft,
    expired: secondsLeft === 0,
    resolved: m.resolved,
    winner,
  };
}

export type QuoteDirection =
  | "usdcToYes"
  | "usdcToNo"
  | "yesToUsdc"
  | "noToUsdc"
  | "yesToNo"
  | "noToYes";

const SWAP_FEE_BPS_MATH = 200; // mirrors constants.SWAP_FEE_BPS (math stays dependency-free)
const Z_CLAMP = 5.9; // the program clamps the sell-side z to ±5.9

/** Gross curve output for `dIn` raw units, mirroring `pm_math::compute_swap_output`. */
function curveOutput(s: MarketState, dir: QuoteDirection, dIn: number): number {
  const { x, y, lEff: L } = s;
  const base = (u: number) => u * capitalPhi(u) + phi(u);
  const clampZ = (z: number) => Math.max(-Z_CLAMP, Math.min(Z_CLAMP, z));
  switch (dir) {
    case "usdcToYes":
      return dIn + (x - findXFromY(y + dIn, L));
    case "usdcToNo":
      return dIn + (y - findYFromX(x + dIn, L));
    case "yesToUsdc":
      return y - L * base(clampZ((y - x - dIn) / L));
    case "noToUsdc": {
      const z = clampZ((y - x + dIn) / L);
      return x - L * (base(z) - z);
    }
    case "yesToNo":
      return y - findYFromX(x + dIn, L);
    case "noToYes":
      return x - findXFromY(y + dIn, L);
  }
}

export interface SwapQuote {
  /** What the user receives, raw 6-dp units (net of the 2% fee). */
  out: number;
  /** Fee charged on the USDC leg, raw units (0 for YES<->NO). */
  fee: number;
  /** out / amountIn. */
  avgPrice: number;
  /** YES price after the swap. */
  priceAfter: number;
}

/**
 * Exact quote for `send.swap(market, direction, amountIn, minOutput)`, in any of
 * the 6 directions, 2% USDC-leg fee included. `amountIn` in raw 6-dp units.
 * Matches `simulateTransaction` to < 0.01% on live devnet markets.
 */
export function quoteSwap(
  m: MarketLike,
  direction: QuoteDirection,
  amountIn: number,
  now = nowSecs(),
): SwapQuote {
  const s = marketState(m, now);
  if (s.resolved || s.expired) throw new Error("market is resolved or expired: no swaps");
  const usdcIn = direction === "usdcToYes" || direction === "usdcToNo";
  const usdcOut = direction === "yesToUsdc" || direction === "noToUsdc";
  const feeIn = usdcIn ? Math.floor((amountIn * SWAP_FEE_BPS_MATH) / 10_000) : 0;
  const dIn = amountIn - feeIn;
  const gross = Math.max(Math.floor(curveOutput(s, direction, dIn)), 0);
  const feeOut = usdcOut ? Math.floor((gross * SWAP_FEE_BPS_MATH) / 10_000) : 0;
  const out = gross - feeOut;
  // Reserve moves: YES in / NO out shift x up; mirror the curve for the price.
  const [xAfter, yAfter] = (() => {
    switch (direction) {
      case "usdcToYes":
      case "noToYes":
        return [findXFromY(s.y + dIn, s.lEff), s.y + dIn];
      case "usdcToNo":
      case "yesToNo":
        return [s.x + dIn, findYFromX(s.x + dIn, s.lEff)];
      case "yesToUsdc":
      case "noToUsdc": {
        const d = direction === "yesToUsdc" ? -dIn : dIn;
        const z = Math.max(-Z_CLAMP, Math.min(Z_CLAMP, (s.y - s.x + d) / s.lEff));
        return [0, z * s.lEff]; // only (y - x) matters for the price
      }
    }
  })();
  const priceAfter = capitalPhi((yAfter - xAfter) / s.lEff);
  return { out, fee: feeIn + feeOut, avgPrice: amountIn > 0 ? out / amountIn : 0, priceAfter };
}

/** `minOutput` for a swap with `slippageBps` tolerance (default 1%). */
export function minOutput(quote: SwapQuote, slippageBps = 100): number {
  return Math.floor((quote.out * (10_000 - slippageBps)) / 10_000);
}
