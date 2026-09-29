# Burner wallet kit: let anyone try your app in one tap

Judges and testers won't install a wallet extension and switch it to devnet.
This kit gives every visitor of your app a **wallet created in their browser
and funded automatically** (1,000 mUSDC + a little devnet SOL for fees), and a
pm-AMM client that signs with it. No popups, no setup.

**Devnet only.** The secret key lives in `localStorage`: fine for play money,
never for real funds. For mainnet, use a real wallet (wallet-adapter) or an
embedded-wallet provider (e.g. Privy).

## Files (copy them into your project)

| File | What |
|---|---|
| [`burner.ts`](burner.ts) | framework-agnostic: create / load / export / import the keypair, fund it through the faucet, build a signing `PmAmmClient` |
| [`useBurnerWallet.ts`](useBurnerWallet.ts) | React hook on top of it |

```bash
npm i @pm-amm/sdk @solana/web3.js @anchor-lang/core @solana/spl-token bs58
curl -sO https://predict-pm-amm.dev/burner/burner.ts
curl -sO https://predict-pm-amm.dev/burner/useBurnerWallet.ts
```

## Use it (React / Next.js)

```tsx
"use client";
import { PublicKey } from "@solana/web3.js";
import { useBurnerWallet } from "./useBurnerWallet";

// minOut: see "Current price" in llms.txt (quote on 98% of the input, then slippage)

export function BuyYes({ market }: { market: PublicKey }) {
  const { client, publicKey, balances, status, error, refresh } = useBurnerWallet();
  if (status !== "ready") return <p>{status === "error" ? error : "Setting up your wallet…"}</p>;
  return (
    <button
      onClick={async () => {
        await client!.send.swap(market, "usdcToYes", 5_000_000, minOut); // raw 6-dp units
        refresh();
      }}
    >
      Buy YES for 5 mUSDC ({balances?.usdc} mUSDC left)
    </button>
  );
}
```

- `status`: `loading` → `funding` → `ready` (or `error`, with a readable `error`).
- `balances`: `{ sol, usdc }`; call `refresh()` after a trade.
- `exportKey()` / `importKey(secret)`: a "copy my wallet" button, or the same
  user on another device. The base58 secret also imports into Phantom.
- `reset()`: throw the wallet away and get a new funded one.
- `useBurnerWallet({ storageKey: "my-app" })`: one wallet per app when several
  apps share a domain (e.g. `localhost`).

Without React: `loadOrCreateBurner()`, `ensureFunded(connection, kp.publicKey)`,
`createBurnerClient(connection, kp)` from `burner.ts`.

## How funding works

The first load calls `POST https://pm-amm-devnet.vercel.app/api/faucet` with
`{"wallet": "<pubkey>", "role": "player"}`: **1,000 mUSDC + 0.02 devnet SOL**.
That's about 6 first trades on different markets (each new position opens a
token account, ~0.002 SOL) and far more repeat trades. It tops up again when the
wallet runs low, limited to once per wallet per hour.

A player wallet can trade, provide liquidity and claim. **Creating markets**
costs ~0.04 SOL each: do that from your own builder wallet (see the quickstart),
not from your users' burners.

## Gotchas

- **Vite / plain bundlers need a `Buffer` polyfill** (`npm i buffer`, then
  `globalThis.Buffer = Buffer` before anything Solana loads). Next.js provides one.
- The hook creates the wallet after mount (`useEffect`), so it's SSR-safe;
  `client` is `null` until then.
- Every visitor gets a new wallet. Anyone can read the key from DevTools, which
  is fine for devnet play money.
- Tested in a browser end-to-end: auto-funding from another origin, the wallet
  survives a reload without re-funding, and a `swap` signed by the burner lands
  on devnet (~0.003 SOL for a first trade).
