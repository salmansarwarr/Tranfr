import * as ccc from "@ckb-ccc/core";
import {
  TranfrConfig,
  TranfrStatus,
  UnlockMode,
  CreateTranfrParams,
  RenewTranfrParams,
  ClaimTranfrParams,
  ReclaimTranfrParams,
} from "./types.js";
import {
  TRANFR_TESTNET_CONFIG,
  NOMINAL_HOURS_PER_EPOCH,
  DEFAULT_DURATION_EPOCHS,
  DEFAULT_FEE_RATE,
  SECP256K1_BLAKE160_CODE_HASH,
} from "./config.js";
import { encodeArgs, decodeArgs, WITNESS_LOCK_LEN } from "./codec.js";
import { signTranfrInput } from "./sign.js";
import {
  packSince,
  recipientPathEligible,
  EPOCH_FRACTION_FLAG,
} from "./since-cmp.js";

const SINCE_EPOCH_VALUE_MASK = 0x00ff_ffff_ffff_ffffn;

/**
 * The lock can only ever verify signatures from a standard secp256k1_blake160
 * lock (docs/spec.md §3.1). Embedding the hash of any other lock makes that
 * role permanently unable to sign, and if both roles are affected the funds
 * are locked forever — so refuse before building such a cell.
 */
export function assertSecp256k1Lock(lockLike: ccc.ScriptLike, role: "owner" | "recipient"): ccc.Script {
  const lock = ccc.Script.from(lockLike);
  const isSecp256k1 =
    lock.codeHash === SECP256K1_BLAKE160_CODE_HASH &&
    lock.hashType === "type" &&
    ccc.bytesFrom(lock.args).length === 20;
  if (!isSecp256k1) {
    throw new Error(
      `The ${role} lock must be a standard secp256k1_blake160 lock (a default CKB address); ` +
        `Tranfr cannot verify signatures from any other lock, so that role could never sign`,
    );
  }
  return lock;
}

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
    // getCell would also return already-spent cells; status must reflect the live set.
    const cell = await this.client.getCellLive(cellOutPoint, true);
    if (!cell) {
      const outPoint = ccc.OutPoint.from(cellOutPoint);
      throw new Error(`No live Tranfr cell at ${outPoint.txHash}:${outPoint.index} (not found or already spent)`);
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
    const ownerLock = assertSecp256k1Lock(params.ownerLock, "owner");
    const recipientLock = assertSecp256k1Lock(params.recipientLock, "recipient");
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
   * The cell's own period: its deadline minus the epoch of the block that
   * committed it, rounded up, and never below the 90-day default. The args
   * store only the deadline, so the period has to be recovered from the chain.
   */
  private async defaultRenewalEpochs(cell: ccc.Cell, deadline: ccc.Epoch): Promise<bigint> {
    const committed = await this.client.getTransaction(cell.outPoint.txHash);
    const header = committed?.blockHash ? await this.client.getHeaderByHash(committed.blockHash) : undefined;
    if (!header) {
      throw new Error(
        "Can't find the block that committed this Tranfr cell to work out its period; pass newDurationEpochs explicitly",
      );
    }

    const period = deadline.sub(header.epoch).normalizeCanonical();
    const whole = BigInt(period.integer);
    const periodEpochs = whole < 0n ? 0n : whole + (BigInt(period.numerator) > 0n ? 1n : 0n);
    return periodEpochs > DEFAULT_DURATION_EPOCHS ? periodEpochs : DEFAULT_DURATION_EPOCHS;
  }

  /**
   * A spend must carry the cell deps of a type script on the cell so it can
   * run. They have to be added here, before signing, since the signature
   * covers the cell deps and callers can't append them afterwards.
   */
  private addSpendCellDeps(tx: ccc.Transaction, cell: ccc.Cell, extraCellDeps: ccc.CellDepLike[] | undefined) {
    tx.addCellDeps(this.getCellDep());
    if (cell.cellOutput.type && !extraCellDeps?.length) {
      throw new Error(
        "This Tranfr cell has a type script; pass that script's cell deps via `cellDeps` " +
          "so the transaction can run it",
      );
    }
    if (extraCellDeps?.length) tx.addCellDeps(extraCellDeps);
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
    const outputIndex = tx.outputs.length - 1;
    const output = tx.outputs[outputIndex];
    const minCapacity = ccc.fixedPointFrom(
      output.occupiedSize + ccc.bytesFrom(tx.outputsData[outputIndex] ?? "0x").length,
    );
    if (output.capacity - fee < minCapacity) {
      throw new Error(
        `Cell capacity ${ccc.fixedPointToString(output.capacity)} CKB cannot cover the fee ` +
          `(${ccc.fixedPointToString(fee)} CKB) and still meet the output's minimum of ` +
          `${ccc.fixedPointToString(minCapacity)} CKB`,
      );
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
    const { cell, ownerPrivateKey, newDurationEpochs, newRecipientLock, feeRate, allowEarlierDeadline } = params;
    const currentArgs = decodeArgs(cell.cellOutput.lock.args);
    const hasValidDeadline = currentArgs.deadlineSince >> 56n === EPOCH_FRACTION_FLAG;
    const currentDeadline = ccc.Epoch.fromNum(currentArgs.deadlineSince & SINCE_EPOCH_VALUE_MASK).normalizeBase();

    const durationEpochs =
      newDurationEpochs ?? (hasValidDeadline ? await this.defaultRenewalEpochs(cell, currentDeadline) : DEFAULT_DURATION_EPOCHS);

    const tipEpoch = await this.getTipEpoch();
    const deadlineEpoch = tipEpoch.add({ integer: durationEpochs, numerator: 0n, denominator: 1n });
    if (hasValidDeadline && deadlineEpoch.lt(currentDeadline) && !allowEarlierDeadline) {
      throw new Error(
        `Renewing for ${durationEpochs} epochs would move the deadline earlier ` +
          `(from epoch ${currentDeadline.integer} to ${deadlineEpoch.integer}); ` +
          "pass a longer newDurationEpochs, or set allowEarlierDeadline to shorten it deliberately",
      );
    }
    const deadlineSince = packSince(
      EPOCH_FRACTION_FLAG,
      BigInt(deadlineEpoch.integer),
      BigInt(deadlineEpoch.numerator),
      BigInt(deadlineEpoch.denominator),
    );

    const recipientLockHash = newRecipientLock
      ? assertSecp256k1Lock(newRecipientLock, "recipient").hash()
      : currentArgs.recipientLockHash;

    const newArgs = encodeArgs({
      ownerLockHash: currentArgs.ownerLockHash,
      recipientLockHash,
      deadlineSince,
    });

    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: cell.outPoint, cellOutput: cell.cellOutput, outputData: cell.outputData }],
      outputs: [{ lock: this.getScript(newArgs), type: cell.cellOutput.type, capacity: cell.cellOutput.capacity }],
      outputsData: [cell.outputData],
    });
    this.addSpendCellDeps(tx, cell, params.cellDeps);

    return this.finalizeSingleOutputSpend(tx, cell.cellOutput.lock, UnlockMode.OWNER, ownerPrivateKey, feeRate);
  }

  /**
   * Step 18: owner-mode spend of the cell to an arbitrary destination lock,
   * with no `since` requirement — the owner can reclaim at any time, even
   * after the recovery deadline has technically passed.
   */
  public async buildOwnerReclaim(params: ReclaimTranfrParams): Promise<ccc.Transaction> {
    const { cell, ownerPrivateKey, feeRate } = params;
    const toLock = params.toLock
      ? ccc.Script.from(params.toLock)
      : (await new ccc.SignerCkbPrivateKey(this.client, ownerPrivateKey).getAddressObjSecp256k1()).script;

    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: cell.outPoint, cellOutput: cell.cellOutput, outputData: cell.outputData }],
      outputs: [{ lock: toLock, type: cell.cellOutput.type, capacity: cell.cellOutput.capacity }],
      outputsData: [cell.outputData],
    });
    this.addSpendCellDeps(tx, cell, params.cellDeps);

    return this.finalizeSingleOutputSpend(tx, cell.cellOutput.lock, UnlockMode.OWNER, ownerPrivateKey, feeRate);
  }

  /**
   * Step 18: recipient-mode spend of the cell to an arbitrary destination
   * lock, with the input's `since` set to the cell's own embedded deadline.
   * Calls `isRecoveryEligible` first and throws client-side rather than
   * constructing a transaction consensus would reject anyway.
   */
  public async buildRecoveryClaim(params: ClaimTranfrParams): Promise<ccc.Transaction> {
    const { cell, recipientPrivateKey, feeRate } = params;
    const args = decodeArgs(cell.cellOutput.lock.args);

    if (!(await this.isRecoveryEligible(args.deadlineSince))) {
      throw new Error("Recovery is not yet eligible: the embedded deadline has not passed");
    }

    const toLock = params.toLock
      ? ccc.Script.from(params.toLock)
      : (await new ccc.SignerCkbPrivateKey(this.client, recipientPrivateKey).getAddressObjSecp256k1()).script;

    const tx = ccc.Transaction.from({
      inputs: [
        {
          previousOutput: cell.outPoint,
          cellOutput: cell.cellOutput,
          outputData: cell.outputData,
          since: args.deadlineSince,
        },
      ],
      outputs: [{ lock: toLock, type: cell.cellOutput.type, capacity: cell.cellOutput.capacity }],
      outputsData: [cell.outputData],
    });
    this.addSpendCellDeps(tx, cell, params.cellDeps);

    return this.finalizeSingleOutputSpend(tx, cell.cellOutput.lock, UnlockMode.RECIPIENT, recipientPrivateKey, feeRate);
  }
}
