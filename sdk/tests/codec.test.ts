import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as ccc from "@ckb-ccc/core";
import {
  encodeArgs,
  decodeArgs,
  encodeWitnessLock,
  decodeWitnessLock,
  ARGS_LEN,
  WITNESS_LOCK_LEN,
  UnlockMode,
  TranfrArgs,
  TranfrWitness,
} from "../src/index.js";

// Load cross-language golden vectors
const goldenVectorsPath = path.resolve("reference/golden_vectors.json");
const goldenVectors = JSON.parse(fs.readFileSync(goldenVectorsPath, "utf-8"));

test("Golden vectors: args encoding and decoding match byte-for-byte", () => {
  for (const vec of goldenVectors.args) {
    const logicalArgs: TranfrArgs = {
      ownerLockHash: vec.ownerLockHash,
      recipientLockHash: vec.recipientLockHash,
      deadlineSince: BigInt(vec.deadlineSince),
    };

    // 1. encode matches expectedHex
    const encoded = encodeArgs(logicalArgs);
    assert.equal(
      encoded.toLowerCase(),
      vec.expectedHex.toLowerCase(),
      `Encoding mismatch for vector: ${vec.description}`
    );

    // 2. decode from expectedHex matches original logical fields
    const decoded = decodeArgs(vec.expectedHex);
    assert.equal(
      decoded.ownerLockHash.toLowerCase(),
      vec.ownerLockHash.toLowerCase(),
      `Decoded ownerLockHash mismatch for vector: ${vec.description}`
    );
    assert.equal(
      decoded.recipientLockHash.toLowerCase(),
      vec.recipientLockHash.toLowerCase(),
      `Decoded recipientLockHash mismatch for vector: ${vec.description}`
    );
    assert.equal(
      decoded.deadlineSince,
      BigInt(vec.deadlineSince),
      `Decoded deadlineSince mismatch for vector: ${vec.description}`
    );
  }
});

test("Golden vectors: witness lock encoding and decoding match byte-for-byte", () => {
  for (const vec of goldenVectors.witness) {
    const logicalWitness: TranfrWitness = {
      mode: vec.mode === 0 ? UnlockMode.OWNER : UnlockMode.RECIPIENT,
      signature: vec.signature,
    };

    // 1. encode matches expectedHex
    const encoded = encodeWitnessLock(logicalWitness);
    assert.equal(
      encoded.toLowerCase(),
      vec.expectedHex.toLowerCase(),
      `Witness encoding mismatch for vector: ${vec.description}`
    );

    // 2. decode from expectedHex matches original logical fields
    const decoded = decodeWitnessLock(vec.expectedHex);
    assert.equal(
      decoded.mode,
      logicalWitness.mode,
      `Decoded mode mismatch for vector: ${vec.description}`
    );
    assert.equal(
      decoded.signature.toLowerCase(),
      vec.signature.toLowerCase(),
      `Decoded signature mismatch for vector: ${vec.description}`
    );
  }
});

test("Roundtrip: encodeArgs -> decodeArgs -> encodeArgs", () => {
  const original: TranfrArgs = {
    ownerLockHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    recipientLockHash: "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
    deadlineSince: 0x2000000000001234n,
  };

  const encoded = encodeArgs(original);
  assert.equal(ccc.bytesFrom(encoded).length, ARGS_LEN);

  const decoded = decodeArgs(encoded);
  assert.deepEqual(decoded, original);

  const reEncoded = encodeArgs(decoded);
  assert.equal(reEncoded, encoded);
});

test("Roundtrip: encodeWitnessLock -> decodeWitnessLock -> encodeWitnessLock", () => {
  const dummySig = ("0x" + "aa".repeat(65)) as ccc.Hex;

  for (const mode of [UnlockMode.OWNER, UnlockMode.RECIPIENT]) {
    const original: TranfrWitness = {
      mode,
      signature: dummySig,
    };

    const encoded = encodeWitnessLock(original);
    assert.equal(ccc.bytesFrom(encoded).length, WITNESS_LOCK_LEN);

    const decoded = decodeWitnessLock(encoded);
    assert.deepEqual(decoded, original);

    const reEncoded = encodeWitnessLock(decoded);
    assert.equal(reEncoded, encoded);
  }
});

test("Defensive: encodeArgs rejects invalid inputs", () => {
  const validHash = "0x" + "00".repeat(32);

  // Short owner lock hash
  assert.throws(
    () =>
      encodeArgs({
        ownerLockHash: ("0x" + "00".repeat(31)) as ccc.Hex,
        recipientLockHash: validHash as ccc.Hex,
        deadlineSince: 100n,
      }),
    /Invalid ownerLockHash length/
  );

  // Long recipient lock hash
  assert.throws(
    () =>
      encodeArgs({
        ownerLockHash: validHash as ccc.Hex,
        recipientLockHash: ("0x" + "00".repeat(33)) as ccc.Hex,
        deadlineSince: 100n,
      }),
    /Invalid recipientLockHash length/
  );

  // Negative deadline
  assert.throws(
    () =>
      encodeArgs({
        ownerLockHash: validHash as ccc.Hex,
        recipientLockHash: validHash as ccc.Hex,
        deadlineSince: -1n,
      }),
    /RangeError/
  );

  // Out of range u64 deadline
  assert.throws(
    () =>
      encodeArgs({
        ownerLockHash: validHash as ccc.Hex,
        recipientLockHash: validHash as ccc.Hex,
        deadlineSince: 0x1_0000_0000_0000_0000n,
      }),
    /RangeError/
  );
});

test("Defensive: decodeArgs rejects invalid lengths", () => {
  assert.throws(() => decodeArgs("0x"), /Invalid Tranfr args length/);
  assert.throws(
    () => decodeArgs(("0x" + "00".repeat(71)) as ccc.Hex),
    /Invalid Tranfr args length: expected 72 bytes, got 71/
  );
  assert.throws(
    () => decodeArgs(("0x" + "00".repeat(73)) as ccc.Hex),
    /Invalid Tranfr args length: expected 72 bytes, got 73/
  );
});

test("Defensive: encodeWitnessLock rejects invalid inputs", () => {
  const validSig = ("0x" + "00".repeat(65)) as ccc.Hex;

  // Invalid mode
  assert.throws(
    () =>
      encodeWitnessLock({
        mode: 2 as UnlockMode,
        signature: validSig,
      }),
    /Invalid unlock mode/
  );

  // Short signature
  assert.throws(
    () =>
      encodeWitnessLock({
        mode: UnlockMode.OWNER,
        signature: ("0x" + "00".repeat(64)) as ccc.Hex,
      }),
    /Invalid signature length/
  );

  // Long signature
  assert.throws(
    () =>
      encodeWitnessLock({
        mode: UnlockMode.OWNER,
        signature: ("0x" + "00".repeat(66)) as ccc.Hex,
      }),
    /Invalid signature length/
  );
});

test("Defensive: decodeWitnessLock rejects invalid inputs", () => {
  // Empty
  assert.throws(() => decodeWitnessLock("0x"), /Invalid Tranfr witness lock length/);

  // Invalid length
  assert.throws(
    () => decodeWitnessLock(("0x" + "00".repeat(65)) as ccc.Hex),
    /Invalid Tranfr witness lock length: expected 66 bytes, got 65/
  );
  assert.throws(
    () => decodeWitnessLock(("0x" + "00".repeat(67)) as ccc.Hex),
    /Invalid Tranfr witness lock length: expected 66 bytes, got 67/
  );

  // Unknown mode byte
  assert.throws(
    () => decodeWitnessLock(("0x02" + "00".repeat(65)) as ccc.Hex),
    /Unknown mode byte: expected 0x00 or 0x01, got 0x02/
  );
  assert.throws(
    () => decodeWitnessLock(("0xff" + "00".repeat(65)) as ccc.Hex),
    /Unknown mode byte: expected 0x00 or 0x01, got 0xff/
  );
});
