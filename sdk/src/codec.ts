import * as ccc from "@ckb-ccc/core";
import { TranfrArgs, TranfrWitness, UnlockMode } from "./types.js";

/**
 * Fixed byte length of Tranfr script args: 32 + 32 + 8 = 72 bytes.
 * Per docs/spec.md §2.
 */
export const ARGS_LEN = 72;

/**
 * Fixed byte length of Tranfr WitnessArgs.lock: 1 + 65 = 66 bytes.
 * Per docs/spec.md §3.
 */
export const WITNESS_LOCK_LEN = 66;

/**
 * Expected byte length for a full 32-byte script hash (Blake2b-256).
 */
export const LOCK_HASH_LEN = 32;

/**
 * Expected byte length for a recoverable secp256k1 signature (r[32] + s[32] + v[1]).
 */
export const SIGNATURE_LEN = 65;

/**
 * Encodes a 64-bit unsigned integer into 8 little-endian bytes.
 */
export function u64ToLeBytes(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(
      `deadlineSince must be an unsigned 64-bit integer, got: ${value.toString()}`
    );
  }
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setBigUint64(0, value, true);
  return buf;
}

/**
 * Decodes 8 little-endian bytes into an unsigned 64-bit integer.
 */
export function u64FromLeBytes(bytes: Uint8Array, offset = 0): bigint {
  if (bytes.length < offset + 8) {
    throw new RangeError(
      `Not enough bytes to read u64: expected at least ${offset + 8}, got ${bytes.length}`
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

/**
 * Encodes Tranfr script args into a 72-byte hex string (0x-prefixed).
 *
 * Byte layout:
 * - [0..32]: owner_lock_hash (32 bytes)
 * - [32..64]: recipient_lock_hash (32 bytes)
 * - [64..72]: deadline_since (8 bytes, little-endian u64)
 */
export function encodeArgs(args: TranfrArgs): ccc.Hex {
  const ownerBytes = ccc.bytesFrom(args.ownerLockHash);
  if (ownerBytes.length !== LOCK_HASH_LEN) {
    throw new Error(
      `Invalid ownerLockHash length: expected ${LOCK_HASH_LEN} bytes, got ${ownerBytes.length}`
    );
  }

  const recipientBytes = ccc.bytesFrom(args.recipientLockHash);
  if (recipientBytes.length !== LOCK_HASH_LEN) {
    throw new Error(
      `Invalid recipientLockHash length: expected ${LOCK_HASH_LEN} bytes, got ${recipientBytes.length}`
    );
  }

  const deadlineBytes = u64ToLeBytes(args.deadlineSince);

  const out = new Uint8Array(ARGS_LEN);
  out.set(ownerBytes, 0);
  out.set(recipientBytes, 32);
  out.set(deadlineBytes, 64);

  return ccc.hexFrom(out);
}

/**
 * Decodes a 72-byte Tranfr script args into its constituent fields.
 */
export function decodeArgs(argsBytesLike: ccc.HexLike | Uint8Array): TranfrArgs {
  const bytes = ccc.bytesFrom(argsBytesLike);
  if (bytes.length !== ARGS_LEN) {
    throw new Error(
      `Invalid Tranfr args length: expected ${ARGS_LEN} bytes, got ${bytes.length}`
    );
  }

  const ownerLockHash = ccc.hexFrom(bytes.slice(0, 32));
  const recipientLockHash = ccc.hexFrom(bytes.slice(32, 64));
  const deadlineSince = u64FromLeBytes(bytes, 64);

  return {
    ownerLockHash,
    recipientLockHash,
    deadlineSince,
  };
}

/**
 * Encodes Tranfr witness lock field into a 66-byte hex string (0x-prefixed).
 *
 * Byte layout:
 * - [0]: mode (1 byte: 0x00=OWNER, 0x01=RECIPIENT)
 * - [1..66]: signature (65 bytes recoverable secp256k1 signature)
 */
export function encodeWitnessLock(witness: TranfrWitness): ccc.Hex {
  if (witness.mode !== UnlockMode.OWNER && witness.mode !== UnlockMode.RECIPIENT) {
    throw new Error(
      `Invalid unlock mode: expected ${UnlockMode.OWNER} (OWNER) or ${UnlockMode.RECIPIENT} (RECIPIENT), got ${witness.mode}`
    );
  }

  const sigBytes = ccc.bytesFrom(witness.signature);
  if (sigBytes.length !== SIGNATURE_LEN) {
    throw new Error(
      `Invalid signature length: expected ${SIGNATURE_LEN} bytes, got ${sigBytes.length}`
    );
  }

  const out = new Uint8Array(WITNESS_LOCK_LEN);
  out[0] = witness.mode;
  out.set(sigBytes, 1);

  return ccc.hexFrom(out);
}

/**
 * Decodes a 66-byte Tranfr witness lock field into mode and signature.
 */
export function decodeWitnessLock(lockBytesLike: ccc.HexLike | Uint8Array): TranfrWitness {
  const bytes = ccc.bytesFrom(lockBytesLike);
  if (bytes.length !== WITNESS_LOCK_LEN) {
    throw new Error(
      `Invalid Tranfr witness lock length: expected ${WITNESS_LOCK_LEN} bytes, got ${bytes.length}`
    );
  }

  const modeByte = bytes[0];
  let mode: UnlockMode;
  if (modeByte === 0x00) {
    mode = UnlockMode.OWNER;
  } else if (modeByte === 0x01) {
    mode = UnlockMode.RECIPIENT;
  } else {
    throw new Error(
      `Unknown mode byte: expected 0x00 or 0x01, got 0x${modeByte.toString(16).padStart(2, "0")}`
    );
  }

  const signature = ccc.hexFrom(bytes.slice(1, 66));

  return {
    mode,
    signature,
  };
}
