import * as ccc from "@ckb-ccc/core";

/**
 * Unlock mode encoded as the first byte of witness.lock.
 * Per docs/spec.md §3:
 * - Mode 0 (OWNER): unconditional spend by owner
 * - Mode 1 (RECIPIENT): timelocked spend by recipient
 */
export enum UnlockMode {
  OWNER = 0,
  RECIPIENT = 1,
}

/**
 * Parsed script args for a tranfr-lock cell (72 bytes total).
 * Per docs/spec.md §2:
 * - owner_lock_hash: 32 bytes (Blake2b-256 hash of owner lock script)
 * - recipient_lock_hash: 32 bytes (Blake2b-256 hash of recipient lock script)
 * - deadline_since: 8 bytes LE u64 (RFC 0017 absolute epoch-fraction format)
 */
export interface TranfrArgs {
  ownerLockHash: ccc.Hex;
  recipientLockHash: ccc.Hex;
  deadlineSince: bigint;
}

/**
 * Parsed witness.lock field for tranfr-lock (66 bytes total).
 * Per docs/spec.md §3:
 * - mode: 1 byte (0=OWNER, 1=RECIPIENT)
 * - signature: 65 bytes (recoverable secp256k1 signature: r[32] + s[32] + v[1])
 */
export interface TranfrWitness {
  mode: UnlockMode;
  signature: ccc.Hex;
}

/**
 * Configuration for the deployed Tranfr script on a specific network.
 */
export interface TranfrConfig {
  /** The code_hash of the deployed tranfr-lock script */
  codeHash: ccc.Hex;
  /** The hash_type of the deployed script ("type" or "data1") */
  hashType: ccc.HashType;
  /** Cell dependency pointing to the on-chain deployed contract binary */
  cellDep: ccc.CellDepLike;
}

/**
 * Live status of a Tranfr cell on-chain.
 */
export interface TranfrStatus {
  cell: ccc.Cell;
  ownerLockHash: ccc.Hex;
  recipientLockHash: ccc.Hex;
  deadlineSince: bigint;
  isClaimable: boolean;
  currentEpochSince: bigint;
  epochsRemaining: bigint;
  estimatedHoursRemaining: number;
}

/**
 * Parameters for creating a new Tranfr cell.
 */
export interface CreateTranfrParams {
  ownerLock: ccc.ScriptLike;
  recipientLock: ccc.ScriptLike;
  capacity: ccc.NumLike;
  durationEpochs?: bigint;
}

/**
 * Parameters for renewing a Tranfr cell.
 * Owner-mode spend of the existing cell into a new output with a freshly
 * computed deadline (and optionally a new recipient) — per docs/spec.md,
 * this is both "heartbeat" and "policy update"; there is no separate
 * on-chain renewal transaction type.
 */
export interface RenewTranfrParams {
  cell: ccc.Cell;
  /** Private key matching the cell's owner_lock_hash, used to sign the OWNER-mode witness. */
  ownerPrivateKey: ccc.HexLike;
  newDurationEpochs?: bigint;
  newRecipientLock?: ccc.ScriptLike;
  /** Fee rate in shannons/KB. Defaults to DEFAULT_FEE_RATE. The fee is deducted from the renewed cell's own capacity. */
  feeRate?: ccc.NumLike;
}

/**
 * Parameters for claiming as recipient.
 */
export interface ClaimTranfrParams {
  cell: ccc.Cell;
  toLock?: ccc.ScriptLike;
}

/**
 * Parameters for owner reclaiming the cell.
 */
export interface ReclaimTranfrParams {
  cell: ccc.Cell;
  toLock?: ccc.ScriptLike;
}
