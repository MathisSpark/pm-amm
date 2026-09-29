import { NextResponse } from "next/server";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createMintToInstruction,
} from "@solana/spl-token";
import { clientIp, rateLimit, rateLimitUndo } from "@/lib/rate-limit";

const AMOUNT = 1000_000_000; // 1000 mUSDC

const HOUR = 3600;
const DAY = 24 * HOUR;
// The mint authority pays every call (fee + ~0.002 SOL rent for a new ATA), so
// cap how fast a script can drain it with fresh wallets. mUSDC itself is free.
const LIMITS = [
  { scope: "wallet", limit: 1, windowSecs: HOUR },
  { scope: "ip", limit: 5, windowSecs: DAY },
  { scope: "global", limit: 500, windowSecs: DAY },
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
  return NextResponse.json(
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

async function mintToWallet(authority: Keypair, recipient: PublicKey, usdcMint: PublicKey) {
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const ata = await getAssociatedTokenAddress(usdcMint, recipient);
  const tx = new Transaction();

  // Create ATA if needed
  if (!(await connection.getAccountInfo(ata))) {
    tx.add(createAssociatedTokenAccountInstruction(authority.publicKey, ata, recipient, usdcMint));
  }
  tx.add(createMintToInstruction(usdcMint, ata, authority.publicKey, AMOUNT));

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
    return NextResponse.json(
      { error: "Faucet disabled on mainnet (real USDC is not mintable)" },
      { status: 503 },
    );
  }
  // Server-only secret: the dedicated mock-USDC mint authority (NOT the upgrade key).
  const keyB64 = process.env.MINT_AUTHORITY_KEY;
  if (!keyB64) {
    return NextResponse.json({ error: "Faucet not configured" }, { status: 503 });
  }
  const usdcMint = new PublicKey(
    process.env.NEXT_PUBLIC_USDC_MINT || "3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ",
  );

  const body = (await req.json().catch(() => ({}))) as { wallet?: unknown };
  const recipient = parseWallet(body.wallet);
  if (!recipient) {
    return NextResponse.json({ error: "Missing or invalid wallet address" }, { status: 400 });
  }

  const limits = await consumeLimits({
    wallet: recipient.toBase58(),
    ip: clientIp(req),
    global: "all",
  });
  if (!limits.ok) return tooMany(limits.scope, limits.retryAfter);

  try {
    const authority = Keypair.fromSecretKey(Buffer.from(keyB64, "base64"));
    const signature = await mintToWallet(authority, recipient, usdcMint);
    return NextResponse.json({ ok: true, signature, amount: AMOUNT / 1e6 });
  } catch (e: unknown) {
    // A failed mint shouldn't cost the user their quota.
    await Promise.all(limits.taken.map(rateLimitUndo));
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 });
  }
}
