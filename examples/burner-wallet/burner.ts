/**
 * Burner wallets for pm-AMM devnet apps: your users trade in one tap, with no
 * wallet extension and no devnet setup.
 *
 * On first load, a keypair is created in the browser (localStorage) and funded
 * by the pm-AMM faucet (1,000 mUSDC + a little devnet SOL for fees). The
 * returned client signs with it directly — no popups.
 *
 * DEVNET ONLY: the secret key lives in localStorage. Never use this pattern
 * with real funds; for mainnet, use a real wallet or an embedded-wallet
 * provider.
 *
 * Deps: @pm-amm/sdk @solana/web3.js @anchor-lang/core @solana/spl-token bs58
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { AnchorProvider } from "@anchor-lang/core";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PmAmmClient } from "@pm-amm/sdk";
import bs58 from "bs58";

export const DEVNET = {
  rpc: "https://api.devnet.solana.com",
  programId: new PublicKey("GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y"),
  usdcMint: new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ"), // mUSDC, 6 dp
  faucetUrl: "https://pm-amm-devnet.vercel.app/api/faucet",
};

/** Change it per app so two apps on the same domain don't share a wallet. */
const DEFAULT_KEY = "pm-amm-burner";

// ---- storage -------------------------------------------------------------

/** The saved burner, or a new one (saved immediately). Browser only. */
export function loadOrCreateBurner(storageKey = DEFAULT_KEY): Keypair {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      return Keypair.fromSecretKey(bs58.decode(saved));
    } catch {
      // corrupted entry: fall through and replace it
    }
  }
  const kp = Keypair.generate();
  localStorage.setItem(storageKey, bs58.encode(kp.secretKey));
  return kp;
}

/** Base58 secret key: importable in Phantom / Solflare, or on another device. */
export function exportBurner(storageKey = DEFAULT_KEY): string | null {
  return localStorage.getItem(storageKey);
}

/** Replace the burner with an exported one. Throws on an invalid key. */
export function importBurner(secretBase58: string, storageKey = DEFAULT_KEY): Keypair {
  const kp = Keypair.fromSecretKey(bs58.decode(secretBase58.trim()));
  localStorage.setItem(storageKey, bs58.encode(kp.secretKey));
  return kp;
}

/** Forget the burner (a fresh one is created on the next load). */
export function resetBurner(storageKey = DEFAULT_KEY): void {
  localStorage.removeItem(storageKey);
}

// ---- balances & funding ---------------------------------------------------

export interface Balances {
  sol: number;
  usdc: number;
}

export async function getBalances(connection: Connection, owner: PublicKey): Promise<Balances> {
  const ata = getAssociatedTokenAddressSync(DEVNET.usdcMint, owner);
  const [lamports, usdc] = await Promise.all([
    connection.getBalance(owner),
    connection
      .getTokenAccountBalance(ata)
      .then((b) => Number(b.value.uiAmount ?? 0))
      .catch(() => 0), // no token account yet
  ]);
  return { sol: lamports / LAMPORTS_PER_SOL, usdc };
}

export type FundResult =
  | { funded: true; signature: string; usdc: number; sol: number }
  | { funded: false; reason: string; retryAfterSecs?: number };

/**
 * Ask the faucet for mUSDC (+ devnet SOL for fees) as a "player" wallet.
 * Never throws: a refusal (e.g. 1 claim per wallet per hour) comes back as
 * `{ funded: false, reason }` so the UI can show it.
 */
export async function fundBurner(connection: Connection, owner: PublicKey): Promise<FundResult> {
  try {
    const res = await fetch(DEVNET.faucetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: owner.toBase58(), role: "player" }),
    });
    const body = await res.json();
    if (!res.ok) {
      const retry = Number(res.headers.get("Retry-After")) || undefined;
      return { funded: false, reason: body.error ?? `faucet ${res.status}`, retryAfterSecs: retry };
    }
    await connection.confirmTransaction(body.signature, "confirmed");
    return { funded: true, signature: body.signature, usdc: body.amount, sol: body.sol ?? 0 };
  } catch (e) {
    // fetch() only throws on network / CORS failures, with a cryptic message.
    const msg = e instanceof Error ? e.message : String(e);
    return { funded: false, reason: `faucet unreachable (${msg})` };
  }
}

/** Below these, `ensureFunded` asks the faucet for a top-up. */
export const LOW = { sol: 0.003, usdc: 10 };

/** Fund the wallet if it is low on SOL or mUSDC. */
export async function ensureFunded(connection: Connection, owner: PublicKey) {
  const before = await getBalances(connection, owner);
  if (before.sol >= LOW.sol && before.usdc >= LOW.usdc) return { balances: before, fund: null };
  const fund = await fundBurner(connection, owner);
  return { balances: fund.funded ? await getBalances(connection, owner) : before, fund };
}

// ---- signing client -------------------------------------------------------

/** Anchor wallet interface backed by a local keypair (signs without popups). */
export function keypairWallet(kp: Keypair) {
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  return {
    publicKey: kp.publicKey,
    payer: kp,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => sign(tx),
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) =>
      txs.map(sign),
  };
}

/** A pm-AMM client that signs with the burner. */
export function createBurnerClient(connection: Connection, kp: Keypair): PmAmmClient {
  const provider = new AnchorProvider(connection, keypairWallet(kp), { commitment: "confirmed" });
  return PmAmmClient.fromProvider(provider, DEVNET.programId, DEVNET.usdcMint);
}
