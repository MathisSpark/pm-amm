"use client";
/**
 * React hook: a funded devnet burner wallet + a signing pm-AMM client.
 *
 *   const { client, publicKey, balances, status, error, refresh } = useBurnerWallet();
 *   await client?.send.swap(market, "usdcToYes", 5_000_000, minOut);
 *   refresh();
 *
 * See burner.ts for the DEVNET-ONLY caveat.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, Keypair } from "@solana/web3.js";
import type { PmAmmClient } from "@pm-amm/sdk";
import {
  DEVNET,
  type Balances,
  createBurnerClient,
  ensureFunded,
  exportBurner,
  getBalances,
  importBurner,
  loadOrCreateBurner,
  resetBurner,
} from "./burner";

export type BurnerStatus = "loading" | "funding" | "ready" | "error";

export function useBurnerWallet(opts: { storageKey?: string; rpc?: string } = {}) {
  const { storageKey, rpc = DEVNET.rpc } = opts;
  const connection = useMemo(() => new Connection(rpc, "confirmed"), [rpc]);
  const [keypair, setKeypair] = useState<Keypair | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [status, setStatus] = useState<BurnerStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  // localStorage only exists in the browser: create/load after mount (SSR-safe).
  useEffect(() => setKeypair(loadOrCreateBurner(storageKey)), [storageKey]);

  const client: PmAmmClient | null = useMemo(
    () => (keypair ? createBurnerClient(connection, keypair) : null),
    [connection, keypair],
  );

  // Fund on first load (and whenever the wallet changes), if it is low.
  useEffect(() => {
    if (!keypair) return;
    let cancelled = false;
    setStatus("funding");
    ensureFunded(connection, keypair.publicKey).then(({ balances, fund }) => {
      if (cancelled) return;
      setBalances(balances);
      const empty = balances.sol === 0 || balances.usdc === 0;
      if (fund && !fund.funded && empty) {
        setError(fund.reason);
        setStatus("error");
      } else {
        setError(null);
        setStatus("ready");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [connection, keypair]);

  /** Re-read balances (call after a trade). */
  const refresh = useCallback(async () => {
    if (keypair) setBalances(await getBalances(connection, keypair.publicKey));
  }, [connection, keypair]);

  return {
    publicKey: keypair?.publicKey ?? null,
    client,
    connection,
    balances,
    status,
    error,
    refresh,
    /** Base58 secret, e.g. for a "copy my wallet" button. */
    exportKey: () => exportBurner(storageKey),
    /** Switch to an exported wallet (e.g. the same user on another device). */
    importKey: (secret: string) => setKeypair(importBurner(secret, storageKey)),
    /** Drop this wallet and start over with a new, freshly funded one. */
    reset: () => {
      resetBurner(storageKey);
      setKeypair(loadOrCreateBurner(storageKey));
    },
  };
}
