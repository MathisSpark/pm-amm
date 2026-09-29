import { NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createMintToInstruction,
} from "@solana/spl-token";
import { clientIp, rateLimit, rateLimitUndo } from "@/lib/rate-limit";

const AMOUNT = 1000_000_000; // 1000 mUSDC

/** Positive integer from env, else the fallback. */
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const solEnv = (name: string) => Math.floor(Number(process.env[name] || 0) * LAMPORTS_PER_SOL);

// Optional devnet SOL drip, paid by the mint authority: public devnet airdrops
// are rate-limited per IP and often dry, which blocks a whole room of builders
// on the same network. Off unless set (in SOL); only tops up wallets holding
// less than the drip. Builders create markets (~0.04 SOL each), so they get
// FAUCET_SOL_DRIP (e.g. 0.2). `role: "player"` is for the burner wallets that
// builders' apps create for their end users, who only pay trade fees and token
// accounts: FAUCET_PLAYER_SOL_DRIP (e.g. 0.02).
const SOL_DRIP = { builder: solEnv("FAUCET_SOL_DRIP"), player: solEnv("FAUCET_PLAYER_SOL_DRIP") };
type Role = keyof typeof SOL_DRIP;

// Drip guards. The drip is the only thing a script can farm for value (fresh
// wallets are free, and `role` is caller-chosen), so: (1) it has its own daily
// budget per IP and role, and (2) it stops when the authority would fall below
// a reserve, so the mUSDC faucet — same tx, same fee payer — never dies with it.
const SOL_RESERVE = solEnv("FAUCET_SOL_RESERVE") || 2 * LAMPORTS_PER_SOL;
/** Rent-exempt minimum of a 0-data system account (a wallet). */
const RENT_EXEMPT_MIN = 890_880;
const DRIP_IP_DAILY_LIMIT: Record<Role, number> = {
  builder: envInt("FAUCET_SOL_DRIP_IP_DAILY_LIMIT", 40),
  player: envInt("FAUCET_PLAYER_SOL_DRIP_IP_DAILY_LIMIT", 150),
};

// Builders' apps call the faucet from their own origin (burner wallets fund
// themselves on first load), so it must answer cross-origin. Devnet only.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return NextResponse.json(body, { status: init.status, headers: { ...CORS, ...init.headers } });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const HOUR = 3600;
const DAY = 24 * HOUR;
// The mint authority pays every call (fee + ~0.002 SOL rent for a new ATA, plus
// the SOL drip when enabled), so cap how fast a script can drain it with fresh
// wallets. mUSDC itself is free. The IP / global caps can be raised for an
// in-person event, where everyone shares one public IP (see DEVNET.md).
const LIMITS = [
  { scope: "wallet", limit: 1, windowSecs: HOUR },
  { scope: "ip", limit: envInt("FAUCET_IP_DAILY_LIMIT", 5), windowSecs: DAY },
  { scope: "global", limit: envInt("FAUCET_GLOBAL_DAILY_LIMIT", 500), windowSecs: DAY },
] as const;

type Scope = (typeof LIMITS)[number]["scope"];

/** Hits every limit in order; on the first refusal, gives back the hits already taken. */
async function consumeLimits(ids: Record<Scope, string>) {
  const taken: string[] = [];
  for (const { scope, limit, windowSecs } of LIMITS) {
    const key = `faucet:${scope}:${ids[scope]}`;
    const res = await rateLimit(key, limit, windowSecs);
    taken.push(key);
    if (!res.ok) {
      await Promise.all(taken.map(rateLimitUndo));
      return { ok: false as const, scope, retryAfter: res.retryAfter };
    }
  }
  return { ok: true as const, taken };
}

function tooMany(scope: Scope, retryAfter: number) {
  const mins = Math.ceil(retryAfter / 60);
  const wait = mins > 90 ? `${Math.ceil(mins / 60)} h` : `${mins} min`;
  const why = {
    wallet: "This wallet already used the faucet",
    ip: "Too many faucet requests from your network",
    global: "The faucet hit its daily cap",
  }[scope];
  return json(
    { error: `${why} — try again in ${wait}` },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

/** Returns the recipient, or null when `wallet` isn't a valid wallet address. */
function parseWallet(wallet: unknown): PublicKey | null {
  if (typeof wallet !== "string" || !wallet) return null;
  try {
    const pk = new PublicKey(wallet);
    return PublicKey.isOnCurve(pk.toBytes()) ? pk : null;
  } catch {
    return null;
  }
}

interface DripPlan {
  lamports: number;
  /** Rate-limit key consumed for this drip (given back if the tx fails). */
  key?: string;
  skipped?: "reserve" | "ip-cap";
}

/** How much SOL to send along with the mUSDC, after the reserve / per-IP guards. */
async function planDrip(
  connection: Connection,
  authority: PublicKey,
  recipient: PublicKey,
  role: Role,
  ip: string,
): Promise<DripPlan> {
  const drip = SOL_DRIP[role];
  if (drip <= 0) return { lamports: 0 };
  const balance = await connection.getBalance(recipient);
  // A drip that leaves the recipient below rent exemption fails the whole tx
  // (mUSDC included), so a too-small setting just disables it.
  if (balance >= drip || balance + drip < RENT_EXEMPT_MIN) return { lamports: 0 };
  if ((await connection.getBalance(authority)) - drip < SOL_RESERVE) {
    return { lamports: 0, skipped: "reserve" };
  }
  const key = `faucet:drip:${role}:${ip}`;
  const res = await rateLimit(key, DRIP_IP_DAILY_LIMIT[role], DAY);
  if (!res.ok) {
    await rateLimitUndo(key);
    return { lamports: 0, skipped: "ip-cap" };
  }
  return { lamports: drip, key };
}

async function mintToWallet(
  connection: Connection,
  authority: Keypair,
  recipient: PublicKey,
  usdcMint: PublicKey,
  dripLamports: number,
) {
  const ata = await getAssociatedTokenAddress(usdcMint, recipient);
  const tx = new Transaction();

  // Create ATA if needed
  if (!(await connection.getAccountInfo(ata))) {
    tx.add(createAssociatedTokenAccountInstruction(authority.publicKey, ata, recipient, usdcMint));
  }
  tx.add(createMintToInstruction(usdcMint, ata, authority.publicKey, AMOUNT));

  if (dripLamports > 0) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: recipient,
        lamports: dripLamports,
      }),
    );
  }

  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(authority);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

export async function POST(req: Request) {
  // Hard-disable on mainnet: real USDC has no mint authority, so the faucet is
  // meaningless there (and we must never wire a mint authority for real funds).
  if (process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet-beta") {
    return json(
      { error: "Faucet disabled on mainnet (real USDC is not mintable)" },
      { status: 503 },
    );
  }
  // Server-only secret: the dedicated mock-USDC mint authority (NOT the upgrade key).
  const keyB64 = process.env.MINT_AUTHORITY_KEY;
  if (!keyB64) {
    return json({ error: "Faucet not configured" }, { status: 503 });
  }
  const usdcMint = new PublicKey(
    process.env.NEXT_PUBLIC_USDC_MINT || "3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ",
  );

  const body = (await req.json().catch(() => ({}))) as { wallet?: unknown; role?: unknown };
  const role: Role = body.role === "player" ? "player" : "builder";
  const recipient = parseWallet(body.wallet);
  if (!recipient) {
    return json({ error: "Missing or invalid wallet address" }, { status: 400 });
  }

  const ip = clientIp(req);
  const limits = await consumeLimits({ wallet: recipient.toBase58(), ip, global: "all" });
  if (!limits.ok) return tooMany(limits.scope, limits.retryAfter);

  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  let drip: DripPlan = { lamports: 0 };
  try {
    const authority = Keypair.fromSecretKey(Buffer.from(keyB64, "base64"));
    drip = await planDrip(connection, authority.publicKey, recipient, role, ip);
    const signature = await mintToWallet(connection, authority, recipient, usdcMint, drip.lamports);
    const sol = drip.lamports / LAMPORTS_PER_SOL;
    return json({ ok: true, signature, amount: AMOUNT / 1e6, sol, solSkipped: drip.skipped });
  } catch (e: unknown) {
    // A failed mint shouldn't cost the user their quota.
    const taken = drip.key ? [...limits.taken, drip.key] : limits.taken;
    await Promise.all(taken.map(rateLimitUndo));
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg.slice(0, 200) }, { status: 500 });
  }
}
