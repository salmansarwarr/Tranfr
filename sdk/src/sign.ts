import * as ccc from "@ckb-ccc/core";
import { UnlockMode } from "./types.js";
import { encodeWitnessLock, WITNESS_LOCK_LEN } from "./codec.js";

/**
 * Signs the witness for the input(s) of `tx` matching `script` with Tranfr's
 * own witness.lock layout (docs/spec.md §3: mode byte + 65-byte recoverable
 * secp256k1 signature), not the standard 65-byte secp256k1_blake160_sighash_all
 * witness.lock.
 *
 * Reuses CCC's own `prepareSighashAllWitness`/`getSignHashInfo` for the
 * sighash_all message construction (tx hash + zeroed-lock witness, per-group
 * and extra witnesses length-prefixed) rather than hand-rolling it again here
 * — this is the same construction verified against the real
 * `secp256k1_blake160_sighash_all` source on the contract side
 * (contracts/tranfr-lock/src/crypto.rs), just invoked through the SDK's own
 * dependency instead of re-deriving it a third time.
 *
 * Assumes exactly one input in `tx` belongs to the Tranfr lock group (the
 * SDK's builder functions only ever spend a single Tranfr cell at a time);
 * `docs/spec.md` §8 / step 8's multi-input-group fix is a script-side
 * concern for transactions this SDK does not construct.
 */
export async function signTranfrInput(
  tx: ccc.Transaction,
  client: ccc.Client,
  script: ccc.ScriptLike,
  mode: UnlockMode,
  privateKey: ccc.HexLike,
): Promise<void> {
  await tx.prepareSighashAllWitness(script, WITNESS_LOCK_LEN, client);

  const signInfo = await tx.getSignHashInfo(script, client);
  if (!signInfo) {
    throw new Error("No input in the transaction matches the Tranfr lock script");
  }

  const signature = ccc.signMessageSecp256k1(signInfo.message, privateKey);
  const witnessArgs = tx.getWitnessArgs(signInfo.position) ?? ccc.WitnessArgs.from({});
  witnessArgs.lock = encodeWitnessLock({ mode, signature });
  tx.setWitnessArgs(signInfo.position, witnessArgs);
}
