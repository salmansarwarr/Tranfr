import test from "node:test";
import assert from "node:assert/strict";
import {
  epochNumberWithFractionCmp,
  sinceValueSatisfied,
  recipientPathEligible,
  packSince,
  EPOCH_FRACTION_FLAG,
  RELATIVE_EPOCH_FRACTION_FLAG,
  ABSOLUTE_BLOCK_NUMBER_FLAG,
} from "./since_cmp";

const SINCE_VALUE_MASK = 0x00ff_ffff_ffff_ffffn;
const pack = (flags: bigint, epoch: bigint, index: bigint, length: bigint) =>
  packSince(flags, epoch, index, length);
const value = (flags: bigint, epoch: bigint, index: bigint, length: bigint) =>
  pack(flags, epoch, index, length) & SINCE_VALUE_MASK;

test("epoch cmp: earlier epoch number always wins regardless of fraction", () => {
  const a = value(0n, 10n, 3n, 4n);
  const b = value(0n, 11n, 0n, 1n);
  assert.equal(epochNumberWithFractionCmp(a, b), -1);
  assert.equal(epochNumberWithFractionCmp(b, a), 1);
});

test("epoch cmp: same epoch, different denominators, equal ratio", () => {
  const a = value(0n, 10n, 1n, 4n);
  const b = value(0n, 10n, 2n, 8n);
  assert.equal(epochNumberWithFractionCmp(a, b), 0);
});

test("epoch cmp: same epoch, different denominators, unequal ratio", () => {
  const a = value(0n, 10n, 3n, 4n);
  const b = value(0n, 10n, 2n, 8n);
  assert.equal(epochNumberWithFractionCmp(a, b), 1);
  assert.equal(epochNumberWithFractionCmp(b, a), -1);
});

test("epoch cmp: raw port does not normalize zero-over-zero by itself (verified quirk)", () => {
  // Mirrors the Rust-side finding from `cargo test`: when the FIRST
  // operand has length === 0, its cross term is always zero regardless
  // of the second operand, so (epoch,0,0) reads as equal to *every*
  // fraction in that epoch, not just to (epoch,0,1).
  const zeroOverZero = value(0n, 10n, 0n, 0n);
  const zeroOverOne = value(0n, 10n, 0n, 1n);
  const nearEndOfEpoch = value(0n, 10n, 999n, 1000n);
  assert.equal(epochNumberWithFractionCmp(zeroOverZero, zeroOverOne), 0);
  assert.equal(epochNumberWithFractionCmp(zeroOverZero, nearEndOfEpoch), 0);
});

test("sinceValueSatisfied requires matching flags", () => {
  const required = pack(EPOCH_FRACTION_FLAG, 100n, 0n, 1n);
  const inputDifferentMetric = pack(ABSOLUTE_BLOCK_NUMBER_FLAG, 100n, 0n, 1n);
  assert.equal(sinceValueSatisfied(inputDifferentMetric, required), false);
});

test("sinceValueSatisfied epoch-fraction boundary is inclusive", () => {
  const required = pack(EPOCH_FRACTION_FLAG, 100n, 1n, 2n);
  const exactlyEqual = pack(EPOCH_FRACTION_FLAG, 100n, 1n, 2n);
  const oneTickBefore = pack(EPOCH_FRACTION_FLAG, 100n, 0n, 2n);
  const oneEpochAfter = pack(EPOCH_FRACTION_FLAG, 101n, 0n, 1n);
  assert.equal(sinceValueSatisfied(exactlyEqual, required), true);
  assert.equal(sinceValueSatisfied(oneTickBefore, required), false);
  assert.equal(sinceValueSatisfied(oneEpochAfter, required), true);
});

test("sinceValueSatisfied non-fraction metric uses plain integer compare", () => {
  const required = pack(ABSOLUTE_BLOCK_NUMBER_FLAG, 1_000_000n, 0n, 0n);
  const earlier = pack(ABSOLUTE_BLOCK_NUMBER_FLAG, 999_999n, 0n, 0n);
  const later = pack(ABSOLUTE_BLOCK_NUMBER_FLAG, 1_000_001n, 0n, 0n);
  assert.equal(sinceValueSatisfied(earlier, required), false);
  assert.equal(sinceValueSatisfied(later, required), true);
});

test("recipientPathEligible rejects relative flag even if numerically far enough", () => {
  const deadline = pack(EPOCH_FRACTION_FLAG, 100n, 0n, 1n);
  const hugeRelative = pack(RELATIVE_EPOCH_FRACTION_FLAG, 1_000_000n, 0n, 1n);
  assert.equal(recipientPathEligible(hugeRelative, deadline), false);
});

test("recipientPathEligible rejects wrong metric on either side", () => {
  const deadlineBlockNumber = pack(ABSOLUTE_BLOCK_NUMBER_FLAG, 500n, 0n, 0n);
  const inputEpochFraction = pack(EPOCH_FRACTION_FLAG, 500n, 0n, 1n);
  assert.equal(recipientPathEligible(inputEpochFraction, deadlineBlockNumber), false);
});

test("recipientPathEligible rejects degenerate zero-length early claim", () => {
  const deadline = pack(EPOCH_FRACTION_FLAG, 540n, 999n, 1000n);
  const degenerateEarlyAttempt = pack(EPOCH_FRACTION_FLAG, 540n, 0n, 0n);

  // Sanity check: the raw (unnormalized) comparison is indeed fooled.
  assert.equal(sinceValueSatisfied(degenerateEarlyAttempt, deadline), true);

  // The Tranfr-level gate must still reject it.
  assert.equal(recipientPathEligible(degenerateEarlyAttempt, deadline), false);

  const honestStartOfEpoch = pack(EPOCH_FRACTION_FLAG, 540n, 0n, 1n);
  assert.equal(recipientPathEligible(honestStartOfEpoch, deadline), false);

  const honestLateFraction = pack(EPOCH_FRACTION_FLAG, 541n, 0n, 1n);
  assert.equal(recipientPathEligible(honestLateFraction, deadline), true);
});

test("recipientPathEligible accepts valid absolute epoch-fraction past deadline", () => {
  const deadline = pack(EPOCH_FRACTION_FLAG, 540n, 0n, 1n);
  const justPast = pack(EPOCH_FRACTION_FLAG, 541n, 0n, 1n);
  const wellBefore = pack(EPOCH_FRACTION_FLAG, 1n, 0n, 1n);
  assert.equal(recipientPathEligible(justPast, deadline), true);
  assert.equal(recipientPathEligible(wellBefore, deadline), false);
});
