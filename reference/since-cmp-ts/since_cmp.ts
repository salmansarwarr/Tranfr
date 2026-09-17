/**
 * TypeScript port of `reference/since-cmp-rs/src/lib.rs`, which is itself
 * a verbatim port of `epoch_number_with_fraction_cmp` (c/utils.h) and the
 * per-input comparison body of `check_since` (c/common.h) from
 * `nervosnetwork/ckb-system-scripts`, plus Tranfr's own recipient-path
 * gate on top of it (`/docs/spec.md` §5).
 *
 * This file is a translation of the already-verified and already-tested
 * Rust module, not an independent re-derivation from the C source or the
 * RFC text — see that file's doc comments and its `cargo test` results
 * for provenance and for the degenerate-zero-length finding this port
 * also guards against (`recipientPathEligible` normalizes before
 * comparing, same as the Rust side).
 *
 * `bigint` is used throughout (never `number`) because `since` values are
 * a full 64 bits and index*length cross-multiplication can exceed
 * `Number.MAX_SAFE_INTEGER`'s 53-bit precision in principle.
 */

const SINCE_VALUE_BITS = 56n;
const SINCE_VALUE_MASK = 0x00ff_ffff_ffff_ffffn;
const SINCE_EPOCH_FRACTION_FLAG = 0x20n; // 0b0010_0000: absolute, epoch metric

const NUMBER_OFFSET = 0n;
const NUMBER_BITS = 24n;
const NUMBER_MASK = (1n << NUMBER_BITS) - 1n;
const INDEX_OFFSET = NUMBER_BITS;
const INDEX_BITS = 16n;
const INDEX_MASK = (1n << INDEX_BITS) - 1n;
const LENGTH_OFFSET = NUMBER_BITS + INDEX_BITS;
const LENGTH_MASK = (1n << 16n) - 1n;

/**
 * Port of `epoch_number_with_fraction_cmp` (c/utils.h). `a` and `b` are
 * the low-56-bit *value* portions of two `since` fields already known to
 * use the epoch-with-fraction metric.
 *
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 *
 * Kept byte-for-byte faithful to the verified source: no normalization
 * of degenerate (index=0,length=0) fractions happens here on purpose —
 * see `normalizeEpochFractionValue` / `recipientPathEligible` below.
 */
export function epochNumberWithFractionCmp(a: bigint, b: bigint): -1 | 0 | 1 {
  const aEpoch = (a >> NUMBER_OFFSET) & NUMBER_MASK;
  const aIndex = (a >> INDEX_OFFSET) & INDEX_MASK;
  const aLen = (a >> LENGTH_OFFSET) & LENGTH_MASK;

  const bEpoch = (b >> NUMBER_OFFSET) & NUMBER_MASK;
  const bIndex = (b >> INDEX_OFFSET) & INDEX_MASK;
  const bLen = (b >> LENGTH_OFFSET) & LENGTH_MASK;

  if (aEpoch < bEpoch) return -1;
  if (aEpoch > bEpoch) return 1;

  const aBlock = aIndex * bLen;
  const bBlock = bIndex * aLen;
  if (aBlock < bBlock) return -1;
  if (aBlock > bBlock) return 1;
  return 0;
}

/**
 * Port of the per-input body of `check_since` (c/common.h): an input's
 * `since` satisfies a required `since` iff their flag bytes match
 * exactly, and (for the epoch-fraction metric) the input's value is >=
 * the required value per `epochNumberWithFractionCmp`, or (for every
 * other metric) the input's raw 56-bit value is >= the required raw
 * value.
 */
export function sinceValueSatisfied(inputSince: bigint, requiredSince: bigint): boolean {
  const inputFlags = inputSince >> SINCE_VALUE_BITS;
  const requiredFlags = requiredSince >> SINCE_VALUE_BITS;
  if (inputFlags !== requiredFlags) return false;

  const inputValue = inputSince & SINCE_VALUE_MASK;
  const requiredValue = requiredSince & SINCE_VALUE_MASK;

  if (inputFlags === SINCE_EPOCH_FRACTION_FLAG) {
    return epochNumberWithFractionCmp(inputValue, requiredValue) >= 0;
  }
  return inputValue >= requiredValue;
}

/**
 * Normalizes the low-56-bit epoch-with-fraction value portion of a
 * `since` value so that index === 0 && length === 0 reads as index=0,
 * length=1 (RFC 0017's stated "exact start of the epoch" case). See the
 * matching Rust doc comment for why this is NOT inside
 * `epochNumberWithFractionCmp` itself, and for the verified finding
 * (via `cargo test` on the Rust side) that the raw comparison treats an
 * un-normalized (epoch,0,0) as equal to *every* fraction in that epoch,
 * not just to (epoch,0,1).
 */
function normalizeEpochFractionValue(value: bigint): bigint {
  const index = (value >> INDEX_OFFSET) & INDEX_MASK;
  const length = (value >> LENGTH_OFFSET) & LENGTH_MASK;
  if (index === 0n && length === 0n) {
    return value | (1n << LENGTH_OFFSET);
  }
  return value;
}

/**
 * Tranfr's recipient-path deadline gate (`/docs/spec.md` §5) — the single
 * source of truth `isRecoveryEligible` (SDK) is built on, and the
 * TypeScript-side mirror of the Rust lock script's own check.
 *
 * Requires both `inputSince` and `deadlineSince` to be absolute +
 * epoch-with-fraction; any other flag combination on either side is
 * rejected outright, never falling back to a different comparison.
 */
export function recipientPathEligible(inputSince: bigint, deadlineSince: bigint): boolean {
  const inputFlags = inputSince >> SINCE_VALUE_BITS;
  const deadlineFlags = deadlineSince >> SINCE_VALUE_BITS;

  if (inputFlags !== SINCE_EPOCH_FRACTION_FLAG || deadlineFlags !== SINCE_EPOCH_FRACTION_FLAG) {
    return false;
  }

  const normalizedInput =
    (inputSince & ~SINCE_VALUE_MASK) | normalizeEpochFractionValue(inputSince & SINCE_VALUE_MASK);
  const normalizedDeadline =
    (deadlineSince & ~SINCE_VALUE_MASK) | normalizeEpochFractionValue(deadlineSince & SINCE_VALUE_MASK);

  return sinceValueSatisfied(normalizedInput, normalizedDeadline);
}

/** Test-only helper: packs (flags, epoch, index, length) into a since-shaped bigint. */
export function packSince(flags: bigint, epoch: bigint, index: bigint, length: bigint): bigint {
  return (
    (flags << SINCE_VALUE_BITS) |
    ((length & LENGTH_MASK) << LENGTH_OFFSET) |
    ((index & INDEX_MASK) << INDEX_OFFSET) |
    ((epoch & NUMBER_MASK) << NUMBER_OFFSET)
  );
}

export const EPOCH_FRACTION_FLAG = SINCE_EPOCH_FRACTION_FLAG;
export const RELATIVE_EPOCH_FRACTION_FLAG = 0xa0n; // relative bit set, epoch metric
export const ABSOLUTE_BLOCK_NUMBER_FLAG = 0x00n;
