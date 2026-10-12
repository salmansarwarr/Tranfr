import * as ccc from "@ckb-ccc/core";
import { TranfrConfig, TranfrStatus, CreateTranfrParams, RenewTranfrParams, UnlockMode } from "./types.js";
import { TRANFR_TESTNET_CONFIG, NOMINAL_HOURS_PER_EPOCH, DEFAULT_DURATION_EPOCHS, DEFAULT_FEE_RATE } from "./config.js";
import { encodeArgs, decodeArgs, WITNESS_LOCK_LEN } from "./codec.js";
import { signTranfrInput } from "./sign.js";
import {
  packSince,
  recipientPathEligible,
  EPOCH_FRACTION_FLAG,
} from "../../reference/since-cmp-ts/since_cmp.js";

const SINCE_EPOCH_VALUE_MASK = 0x00ff_ffff_ffff_ffffn;

/**
 * High-level Tranfr SDK client built on top of CCC (ckb-devrel/ccc).
 * Handles script construction, network RPC interaction, and cell querying.
 */
export class TranfrClient {
  public readonly client: ccc.Client;
  public readonly config: TranfrConfig;

  constructor(options?: { client?: ccc.Client; config?: TranfrConfig }) {
    this.client = options?.client ?? new ccc.ClientPublicTestnet();
    this.config = options?.config ?? TRANFR_TESTNET_CONFIG;
  }

  /**
   * Constructs the on-chain Tranfr lock Script instance with the specified args.
   */
  public getScript(args: ccc.Hex): ccc.Script {
    return new ccc.Script(this.config.codeHash, this.config.hashType, args);
  }

  /**
   * Returns the CellDep needed to execute transactions spending tranfr-lock cells.
   */
  public getCellDep(): ccc.CellDep {
    return ccc.CellDep.from(this.config.cellDep);
  }

  /**
   * Fetches the current tip epoch information from the connected CKB node.
   */
  public async getTipEpoch(): Promise<ccc.Epoch> {
    const header = await this.client.getTipHeader();
    return header.epoch;
  }

  /**
   * Packs a ccc.Epoch into a Tranfr/RFC-0017-shaped absolute epoch-with-fraction
   * `since` bigint — the same shape as `deadline_since` (docs/spec.md §4).
   */
  private epochToSince(epoch: ccc.Epoch): bigint {
    return packSince(EPOCH_FRACTION_FLAG, BigInt(epoch.integer), BigInt(epoch.numerator), BigInt(epoch.denominator));
  }

  /**
   * Step 14: checks whether a recipient claim against `deadlineSince` would
   * be accepted by the script *right now*, by fetching the live tip epoch and
   * running it through the same verified comparison (`recipientPathEligible`)
   * the lock script itself uses — a single source of truth, not a third
   * reimplementation (docs/spec.md §5).
   */
  public async isRecoveryEligible(deadlineSince: bigint): Promise<boolean> {
    const tipEpoch = await this.getTipEpoch();
    const currentSince = this.epochToSince(tipEpoch);
    return recipientPathEligible(currentSince, deadlineSince);
  }

  /**
   * Step 15: fetches the live Tranfr cell, decodes its lock args, and combines
   * that with `isRecoveryEligible` to report its current status.
   */
  public async getTranfrStatus(cellOutPoint: ccc.OutPointLike): Promise<TranfrStatus> {
    const cell = await this.client.getCell(cellOutPoint);
    if (!cell) {
      const outPoint = ccc.OutPoint.from(cellOutPoint);
      throw new Error(`Tranfr cell not found at ${outPoint.txHash}:${outPoint.index}`);
    }

    const args = decodeArgs(cell.cellOutput.lock.args);
    const tipEpoch = await this.getTipEpoch();
    const currentEpochSince = this.epochToSince(tipEpoch);
    const isClaimable = recipientPathEligible(currentEpochSince, args.deadlineSince);

    let epochsRemaining = 0n;
    if (!isClaimable) {
      const deadlineEpoch = ccc.Epoch.fromNum(args.deadlineSince & SINCE_EPOCH_VALUE_MASK);
      const remaining = deadlineEpoch.sub(tipEpoch).normalizeCanonical();
      const wholeRemaining = BigInt(remaining.integer);
      const hasPartialEpoch = BigInt(remaining.numerator) > 0n;
      epochsRemaining = wholeRemaining < 0n ? 0n : wholeRemaining + (hasPartialEpoch ? 1n : 0n);
    }

    return {
      cell,
      ownerLockHash: args.ownerLockHash,
      recipientLockHash: args.recipientLockHash,
      deadlineSince: args.deadlineSince,
      isClaimable,
      currentEpochSince,
      epochsRemaining,
      estimatedHoursRemaining: Number(epochsRemaining) * NOMINAL_HOURS_PER_EPOCH,
    };
  }

  /**
   * Step 16: builds a tx with one Tranfr output whose args embed
   * `deadlineSince = currentEpoch + durationEpochs` (default: DEFAULT_DURATION_EPOCHS,
   * the ~90-day value from docs/epoch-length.md). Returns an incomplete
   * transaction — the caller still needs to fund it (`completeInputsByCapacity`),
   * pay the fee (`completeFeeBy`), sign with their own wallet signer, and send it;
   * this function never hand-rolls that funding/signing flow.
   */
  public async createTranfr(params: CreateTranfrParams): Promise<ccc.Transaction> {
    const ownerLock = ccc.Script.from(params.ownerLock);
    const recipientLock = ccc.Script.from(params.recipientLock);
    const durationEpochs = params.durationEpochs ?? DEFAULT_DURATION_EPOCHS;

    const tipEpoch = await this.getTipEpoch();
    const deadlineEpoch = tipEpoch.add({ integer: durationEpochs, numerator: 0n, denominator: 1n });
    const deadlineSince = packSince(
      EPOCH_FRACTION_FLAG,
      BigInt(deadlineEpoch.integer),
      BigInt(deadlineEpoch.numerator),
      BigInt(deadlineEpoch.denominator),
    );

    const args = encodeArgs({
      ownerLockHash: ownerLock.hash(),
      recipientLockHash: recipientLock.hash(),
      deadlineSince,
    });

    const tx = ccc.Transaction.from({
      outputs: [{ lock: this.getScript(args), capacity: params.capacity }],
      outputsData: ["0x"],
    });
    tx.addCellDeps(this.getCellDep());

    return tx;
  }

  /**
   * Shared tail end of renew/reclaim/claim: pads the matching input's witness
   * to Tranfr's fixed 66-byte lock length, deducts the exact resulting fee
   * (the witness length — and therefore the tx's byte length — is already
   * final, so this is an exact fee, not an estimate requiring iteration) from
   * the transaction's single output, then signs with the real witness.
   */
  private async finalizeSingleOutputSpend(
    tx: ccc.Transaction,
    script: ccc.ScriptLike,
    mode: UnlockMode,
    privateKey: ccc.HexLike,
    feeRate: ccc.NumLike | undefined,
  ): Promise<ccc.Transaction> {
    await tx.prepareSighashAllWitness(script, WITNESS_LOCK_LEN, this.client);

    const fee = tx.estimateFee(feeRate ?? DEFAULT_FEE_RATE);
    const output = tx.outputs[tx.outputs.length - 1];
    if (output.capacity < fee) {
      throw new Error(`Cell capacity ${output.capacity} is insufficient to cover fee ${fee}`);
    }
    output.capacity -= fee;

    await signTranfrInput(tx, this.client, script, mode, privateKey);
    return tx;
  }

  /**
   * Step 17: owner-mode spend of the existing cell into a new output with a
   * freshly computed deadline (and optionally a new recipient). This is both
   * "heartbeat" and "policy update" — the owner path is unconditional, so
   * there is no separate on-chain renewal transaction type.
   */
  public async renewTranfr(params: RenewTranfrParams): Promise<ccc.Transaction> {
    const { cell, ownerPrivateKey, newDurationEpochs, newRecipientLock, feeRate } = params;
    const currentArgs = decodeArgs(cell.cellOutput.lock.args);
    const durationEpochs = newDurationEpochs ?? DEFAULT_DURATION_EPOCHS;

    const tipEpoch = await this.getTipEpoch();
    const deadlineEpoch = tipEpoch.add({ integer: durationEpochs, numerator: 0n, denominator: 1n });
    const deadlineSince = packSince(
      EPOCH_FRACTION_FLAG,
      BigInt(deadlineEpoch.integer),
      BigInt(deadlineEpoch.numerator),
      BigInt(deadlineEpoch.denominator),
    );

    const recipientLockHash = newRecipientLock
      ? ccc.Script.from(newRecipientLock).hash()
      : currentArgs.recipientLockHash;

    const newArgs = encodeArgs({
      ownerLockHash: currentArgs.ownerLockHash,
      recipientLockHash,
      deadlineSince,
    });

    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: cell.outPoint, cellOutput: cell.cellOutput, outputData: cell.outputData }],
      outputs: [{ lock: this.getScript(newArgs), capacity: cell.cellOutput.capacity }],
      outputsData: [cell.outputData],
    });
    tx.addCellDeps(this.getCellDep());

    return this.finalizeSingleOutputSpend(tx, cell.cellOutput.lock, UnlockMode.OWNER, ownerPrivateKey, feeRate);
  }
}
