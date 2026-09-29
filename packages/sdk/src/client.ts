/**
 * PmAmmClient — the single entry point bound to one deployment.
 *
 * It owns the `{...idl, address: programId}` override ONCE (the app previously
 * repeated this in 5 places), exposes typed reads + PDA helpers + the 26
 * instruction builders (`ix.*`), and — when a provider is supplied — the
 * `send.*` convenience wrappers and multi-tx `flows.*`.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  type Commitment,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import { Program, AnchorProvider } from "@anchor-lang/core";
import idlJson from "./idl/pm_amm.json";
import type { PmAmm } from "./idl/pm_amm";
import { METAPLEX_PROGRAM_ID } from "./constants";
import type { IxContext } from "./ix/context";
import * as builders from "./ix";
import {
  deriveMarketPda,
  deriveYesMint,
  deriveNoMint,
  deriveMarketVault,
  deriveLpPosition,
  deriveGroupPda,
  deriveVaultPda,
  deriveVaultCollateralPda,
  deriveCommitPositionPda,
  deriveVaultGroupPda,
  deriveVaultGroupCollateralPda,
  deriveCommitGroupPositionPda,
  deriveBetVaultPda,
  deriveBetPositionPda,
  deriveBetVaultCollateral,
  deriveMetadataPda,
} from "./pda";
import type {
  ProgramAccountNamespace,
  MarketAccount,
  GroupMarketAccount,
  LpPositionAccount,
  CommitmentVaultAccount,
  CommitPositionAccount,
  CommitmentVaultGroupAccount,
  CommitPositionGroupAccount,
  BetVaultAccount,
  BetPositionAccount,
} from "./types/accounts";
import { makeSend, type SendApi } from "./send";
import { makeFlows, type FlowsApi } from "./flows";

export interface PmAmmConfig {
  connection: Connection;
  /** The deployed program id — overrides the bundled IDL address. */
  programId: PublicKey;
  /** Collateral (mock USDC) mint for this deployment. */
  collateralMint: PublicKey;
  /** Defaults to the canonical Metaplex Token Metadata program. */
  metaplexProgramId?: PublicKey;
  /** Supply to enable `send.*` / `flows.*` (signing). Omit for read-only. */
  provider?: AnchorProvider;
  commitment?: Commitment;
}

export class PmAmmClient {
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly collateralMint: PublicKey;
  readonly metaplexProgramId: PublicKey;
  readonly program: Program<PmAmm>;
  readonly accounts: ProgramAccountNamespace;
  readonly ctx: IxContext;
  private readonly provider?: AnchorProvider;

  /** Composable instruction builders (no signing) for all 34 instructions. */
  readonly ix: BoundIx;
  /** Convenience send wrappers (require a provider). */
  readonly send: SendApi;
  /** Multi-transaction orchestrations (require a provider). */
  readonly flows: FlowsApi;

  constructor(cfg: PmAmmConfig) {
    this.connection = cfg.connection;
    this.programId = cfg.programId;
    this.collateralMint = cfg.collateralMint;
    this.metaplexProgramId = cfg.metaplexProgramId ?? METAPLEX_PROGRAM_ID;
    this.provider = cfg.provider;

    // Read-only callers pass no provider; Anchor only needs `connection` to
    // decode accounts. The single documented cast in the whole SDK.
    const provider = cfg.provider ?? ({ connection: cfg.connection } as unknown as AnchorProvider);

    // Override the bundled IDL's hard-coded address with this deployment's
    // program id (the JSON ships with whatever `declare_id!` was at build).
    const idl = { ...(idlJson as object), address: cfg.programId.toBase58() } as unknown as PmAmm;
    this.program = new Program<PmAmm>(idl, provider);
    this.accounts = this.program.account as unknown as ProgramAccountNamespace;

    this.ctx = {
      program: this.program,
      programId: this.programId,
      collateralMint: this.collateralMint,
      metaplexProgramId: this.metaplexProgramId,
    };

    this.ix = bindBuilders(this.ctx);
    this.send = makeSend(this);
    this.flows = makeFlows(this);
  }

  /** Read-only client (no signing). */
  static readOnly(
    connection: Connection,
    programId: PublicKey,
    collateralMint: PublicKey,
    opts?: { metaplexProgramId?: PublicKey; commitment?: Commitment },
  ): PmAmmClient {
    return new PmAmmClient({ connection, programId, collateralMint, ...opts });
  }

  /** Signing client from a prebuilt AnchorProvider (e.g. from a wallet adapter). */
  static fromProvider(
    provider: AnchorProvider,
    programId: PublicKey,
    collateralMint: PublicKey,
    opts?: { metaplexProgramId?: PublicKey; commitment?: Commitment },
  ): PmAmmClient {
    return new PmAmmClient({
      connection: provider.connection,
      programId,
      collateralMint,
      provider,
      ...opts,
    });
  }

  // --------------------------------------------------------------------------
  // Provider / tx helpers (used by send.* and flows.*)
  // --------------------------------------------------------------------------

  requireProvider(): AnchorProvider {
    if (!this.provider) {
      throw new Error("PmAmmClient: this operation requires a wallet/provider (use fromProvider).");
    }
    return this.provider;
  }

  /** Signer pubkey from the bound wallet. */
  walletPubkey(): PublicKey {
    return this.requireProvider().wallet.publicKey;
  }

  /** Assemble the instructions into one tx and send + confirm. */
  async sendIxs(ixs: TransactionInstruction[], signers: Signer[] = []): Promise<string> {
    const provider = this.requireProvider();
    const tx = new Transaction().add(...ixs);
    return provider.sendAndConfirm(tx, signers);
  }

  // --------------------------------------------------------------------------
  // PDA helpers (bound to this.programId)
  // --------------------------------------------------------------------------

  marketPda = (id: number | bigint) => deriveMarketPda(this.programId, id);
  yesMint = (market: PublicKey) => deriveYesMint(this.programId, market);
  noMint = (market: PublicKey) => deriveNoMint(this.programId, market);
  marketVault = (market: PublicKey) => deriveMarketVault(this.programId, market);
  lpPosition = (market: PublicKey, owner: PublicKey) =>
    deriveLpPosition(this.programId, market, owner);
  groupPda = (id: number | bigint) => deriveGroupPda(this.programId, id);
  vaultPda = (id: number | bigint) => deriveVaultPda(this.programId, id);
  vaultCollateral = (vault: PublicKey) => deriveVaultCollateralPda(this.programId, vault);
  commitPosition = (vault: PublicKey, owner: PublicKey) =>
    deriveCommitPositionPda(this.programId, vault, owner);
  vaultGroupPda = (id: number | bigint) => deriveVaultGroupPda(this.programId, id);
  vaultGroupCollateral = (vault: PublicKey) => deriveVaultGroupCollateralPda(this.programId, vault);
  commitGroupPosition = (vault: PublicKey, owner: PublicKey) =>
    deriveCommitGroupPositionPda(this.programId, vault, owner);
  betVaultPda = (id: number | bigint) => deriveBetVaultPda(this.programId, id);
  betPosition = (betVault: PublicKey, owner: PublicKey) =>
    deriveBetPositionPda(this.programId, betVault, owner);
  betVaultCollateral = (betVault: PublicKey, mint: PublicKey = this.collateralMint) =>
    deriveBetVaultCollateral(betVault, mint);
  metadataPda = (mint: PublicKey) => deriveMetadataPda(mint, this.metaplexProgramId);

  // --------------------------------------------------------------------------
  // Reads (typed, decoded accounts). `dataSize` filters legacy layouts when set.
  // --------------------------------------------------------------------------

  fetchMarket(pda: PublicKey): Promise<MarketAccount | null> {
    return this.accounts.market.fetchNullable(pda);
  }
  /** Many markets in ONE RPC call (the public devnet RPC rate-limits hard). null = not a market. */
  fetchMarkets(pdas: PublicKey[]): Promise<(MarketAccount | null)[]> {
    return this.program.account.market.fetchMultiple(pdas) as Promise<(MarketAccount | null)[]>;
  }
  fetchAllMarkets(dataSize?: number) {
    return this.accounts.market.all(dataSize ? [{ dataSize }] : undefined);
  }
  fetchGroup(pda: PublicKey): Promise<GroupMarketAccount | null> {
    return this.accounts.groupMarket.fetchNullable(pda);
  }
  fetchAllGroups(dataSize?: number) {
    return this.accounts.groupMarket.all(dataSize ? [{ dataSize }] : undefined);
  }
  fetchLpPosition(market: PublicKey, owner: PublicKey): Promise<LpPositionAccount | null> {
    return this.accounts.lpPosition.fetchNullable(this.lpPosition(market, owner));
  }
  fetchVault(pda: PublicKey): Promise<CommitmentVaultAccount | null> {
    return this.accounts.commitmentVault.fetchNullable(pda);
  }
  fetchAllVaults(dataSize?: number) {
    return this.accounts.commitmentVault.all(dataSize ? [{ dataSize }] : undefined);
  }
  fetchCommitPosition(vault: PublicKey, owner: PublicKey): Promise<CommitPositionAccount | null> {
    return this.accounts.commitPosition.fetchNullable(this.commitPosition(vault, owner));
  }
  fetchVaultGroup(pda: PublicKey): Promise<CommitmentVaultGroupAccount | null> {
    return this.accounts.commitmentVaultGroup.fetchNullable(pda);
  }
  fetchAllVaultGroups(dataSize?: number) {
    return this.accounts.commitmentVaultGroup.all(dataSize ? [{ dataSize }] : undefined);
  }
  fetchCommitGroupPosition(
    vault: PublicKey,
    owner: PublicKey,
  ): Promise<CommitPositionGroupAccount | null> {
    return this.accounts.commitPositionGroup.fetchNullable(this.commitGroupPosition(vault, owner));
  }
  fetchBetVault(pda: PublicKey): Promise<BetVaultAccount | null> {
    return this.accounts.betVault.fetchNullable(pda);
  }
  fetchAllBetVaults(dataSize?: number) {
    return this.accounts.betVault.all(dataSize ? [{ dataSize }] : undefined);
  }
  fetchBetPosition(betVault: PublicKey, owner: PublicKey): Promise<BetPositionAccount | null> {
    return this.accounts.betPosition.fetchNullable(this.betPosition(betVault, owner));
  }
}

// ----------------------------------------------------------------------------
// Instruction builder binding — `client.ix.<name>(params)` (ctx pre-applied)
// Builders are exported as `buildInitializeMarket`; exposed as `initializeMarket`.
// ----------------------------------------------------------------------------

/** Drop the leading `ctx` argument from a builder signature. */
type StripCtx<F> = F extends (ctx: IxContext, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
/** `"buildInitializeMarket"` → `"initializeMarket"`; anything else → never. */
type IxName<K> = K extends `build${infer Rest}` ? Uncapitalize<Rest> : never;

type BoundIx = {
  [K in keyof typeof builders as IxName<K & string>]: StripCtx<(typeof builders)[K]>;
};

function bindBuilders(ctx: IxContext): BoundIx {
  const out = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(builders)) {
    if (typeof fn === "function" && name.startsWith("build")) {
      const key = name.charAt(5).toLowerCase() + name.slice(6);
      out[key] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(ctx, ...args);
    }
  }
  return out as BoundIx;
}
