import test from "node:test";
import assert from "node:assert/strict";
import * as ccc from "@ckb-ccc/core";
import {
  TranfrClient,
  TRANFR_TESTNET_CONFIG,
  UnlockMode,
  decodeArgs,
  decodeWitnessLock,
  packSince,
  EPOCH_FRACTION_FLAG,
  WITNESS_LOCK_LEN,
} from "../src/index.js";

// Private key 1 (scalar value 1): a minimal, deterministic valid secp256k1 key for tests.
const OWNER_PRIVATE_KEY: ccc.Hex = `0x${"00".repeat(31)}01`;
const RECIPIENT_PRIVATE_KEY: ccc.Hex = `0x${"00".repeat(31)}02`;

// getSignHashInfo hashes whatever is in the witness, so re-zero the lock on a
// clone to recover the exact message signTranfrInput signed over.
async function recomputeSignMessage(tx: ccc.Transaction, client: ccc.Client, script: ccc.ScriptLike) {
  const verifyTx = tx.clone();
  verifyTx.setWitnessArgs(0, { lock: ccc.hexFrom(new Uint8Array(WITNESS_LOCK_LEN)) });
  return verifyTx.getSignHashInfo(script, client);
}

/**
 * Minimal `ccc.Client` test double. Only implements the handful of RPC
 * methods the SDK's steps-14-18 functions actually call (`getTipHeader`,
 * `getCell`), so tip-epoch-dependent logic (isRecoveryEligible,
 * getTranfrStatus, createTranfr, renewTranfr) can be tested deterministically
 * and offline instead of racing a live testnet tip.
 */
class FakeClient {
  // Known-script lookup (used to derive a key's default secp256k1 lock) is
  // static per-network config, so it delegates to the real testnet client.
  private readonly testnet = new ccc.ClientPublicTestnet();

  constructor(
    private readonly tipEpoch: ccc.EpochLike,
    private readonly cells: Map<string, ccc.Cell> = new Map(),
  ) {}

  get addressPrefix() {
    return this.testnet.addressPrefix;
  }

  getKnownScript(script: ccc.KnownScript) {
    return this.testnet.getKnownScript(script);
  }

  async getTipHeader() {
    return { epoch: ccc.Epoch.from(this.tipEpoch) } as unknown as ccc.ClientBlockHeader;
  }

  async getCell(outPointLike: ccc.OutPointLike) {
    const outPoint = ccc.OutPoint.from(outPointLike);
    return this.cells.get(`${outPoint.txHash}:${outPoint.index}`);
  }
}

function fakeClient(tipEpoch: ccc.EpochLike, cells?: Map<string, ccc.Cell>): ccc.Client {
  return new FakeClient(tipEpoch, cells) as unknown as ccc.Client;
}

function dummyLockHash(byte: number): ccc.Hex {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as ccc.Hex;
}

test("isRecoveryEligible returns false before the deadline and true at/after it", async () => {
  const deadline = packSince(EPOCH_FRACTION_FLAG, 540n, 0n, 1n);

  const beforeClient = new TranfrClient({ client: fakeClient([539n, 0n, 1n]) });
  assert.equal(await beforeClient.isRecoveryEligible(deadline), false);

  const atClient = new TranfrClient({ client: fakeClient([540n, 0n, 1n]) });
  assert.equal(await atClient.isRecoveryEligible(deadline), true);

  const afterClient = new TranfrClient({ client: fakeClient([541n, 0n, 1n]) });
  assert.equal(await afterClient.isRecoveryEligible(deadline), true);
});

function buildTranfrCell(args: { ownerLockHash: ccc.Hex; recipientLockHash: ccc.Hex; deadlineSince: bigint }, capacity = 100_00000000n) {
  const client = new TranfrClient();
  const encodedArgs = ccc.hexFrom(
    ccc.bytesConcat(
      ccc.bytesFrom(args.ownerLockHash),
      ccc.bytesFrom(args.recipientLockHash),
      (() => {
        const buf = new Uint8Array(8);
        new DataView(buf.buffer).setBigUint64(0, args.deadlineSince, true);
        return buf;
      })(),
    ),
  );
  const lock = client.getScript(encodedArgs);
  const outPoint = ccc.OutPoint.from({ txHash: `0x${"ab".repeat(32)}`, index: 0 });
  const cell = ccc.Cell.from({
    outPoint,
    cellOutput: { capacity, lock },
    outputData: "0x",
  });
  return cell;
}

test("getTranfrStatus decodes args and reports claimability/epochsRemaining correctly", async () => {
  const ownerLockHash = dummyLockHash(0x11);
  const recipientLockHash = dummyLockHash(0x22);
  const deadlineSince = packSince(EPOCH_FRACTION_FLAG, 600n, 0n, 1n);
  const cell = buildTranfrCell({ ownerLockHash, recipientLockHash, deadlineSince });

  const cells = new Map([[`${cell.outPoint.txHash}:${cell.outPoint.index}`, cell]]);

  const beforeDeadline = new TranfrClient({ client: fakeClient([590n, 0n, 1n], cells) });
  const statusBefore = await beforeDeadline.getTranfrStatus(cell.outPoint);
  assert.equal(statusBefore.ownerLockHash, ownerLockHash);
  assert.equal(statusBefore.recipientLockHash, recipientLockHash);
  assert.equal(statusBefore.deadlineSince, deadlineSince);
  assert.equal(statusBefore.isClaimable, false);
  assert.equal(statusBefore.epochsRemaining, 10n);

  const afterDeadline = new TranfrClient({ client: fakeClient([600n, 0n, 1n], cells) });
  const statusAfter = await afterDeadline.getTranfrStatus(cell.outPoint);
  assert.equal(statusAfter.isClaimable, true);
  assert.equal(statusAfter.epochsRemaining, 0n);
});

test("getTranfrStatus throws when the cell does not exist", async () => {
  const client = new TranfrClient({ client: fakeClient([0n, 0n, 1n]) });
  await assert.rejects(() => client.getTranfrStatus({ txHash: `0x${"00".repeat(32)}`, index: 0 }));
});

test("createTranfr builds an output encoding currentEpoch + durationEpochs as the deadline", async () => {
  const client = new TranfrClient({ client: fakeClient([100n, 0n, 1n]) });
  const ownerLock = ccc.Script.from({ codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: "0x01" });
  const recipientLock = ccc.Script.from({ codeHash: `0x${"22".repeat(32)}`, hashType: "type", args: "0x02" });

  const tx = await client.createTranfr({
    ownerLock,
    recipientLock,
    capacity: 300_00000000n,
    durationEpochs: 10n,
  });

  assert.equal(tx.outputs.length, 1);
  assert.equal(tx.outputs[0].capacity, 300_00000000n);
  assert.equal(tx.outputs[0].lock.codeHash, TRANFR_TESTNET_CONFIG.codeHash);

  const args = decodeArgs(tx.outputs[0].lock.args);
  assert.equal(args.ownerLockHash, ownerLock.hash());
  assert.equal(args.recipientLockHash, recipientLock.hash());
  assert.equal(args.deadlineSince, packSince(EPOCH_FRACTION_FLAG, 110n, 0n, 1n));

  assert.equal(tx.cellDeps.length, 1);
  assert.equal(tx.cellDeps[0].outPoint.txHash, TRANFR_TESTNET_CONFIG.cellDep.outPoint.txHash);
});

test("renewTranfr recreates the cell with a new deadline and OWNER-mode witness", async () => {
  const ownerSigner = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), OWNER_PRIVATE_KEY);
  const ownerScript = (await ownerSigner.getAddressObjSecp256k1()).script;
  const recipientLockHash = dummyLockHash(0x22);
  const oldDeadline = packSince(EPOCH_FRACTION_FLAG, 100n, 0n, 1n);

  const cell = buildTranfrCell({
    ownerLockHash: ownerScript.hash(),
    recipientLockHash,
    deadlineSince: oldDeadline,
  });

  const client = new TranfrClient({ client: fakeClient([200n, 0n, 1n]) });

  const tx = await client.renewTranfr({
    cell,
    ownerPrivateKey: OWNER_PRIVATE_KEY,
    newDurationEpochs: 10n,
  });

  const newArgs = decodeArgs(tx.outputs[0].lock.args);
  assert.equal(newArgs.ownerLockHash, ownerScript.hash());
  assert.equal(newArgs.recipientLockHash, recipientLockHash);
  assert.equal(newArgs.deadlineSince, packSince(EPOCH_FRACTION_FLAG, 210n, 0n, 1n));
  assert.ok(tx.outputs[0].capacity < cell.cellOutput.capacity);

  const witnessArgs = tx.getWitnessArgs(0);
  const witness = decodeWitnessLock(witnessArgs!.lock!);
  assert.equal(witness.mode, UnlockMode.OWNER);
});

test("renewTranfr can change the recipient", async () => {
  const ownerSigner = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), OWNER_PRIVATE_KEY);
  const ownerScript = (await ownerSigner.getAddressObjSecp256k1()).script;
  const oldRecipientLockHash = dummyLockHash(0x22);
  const newRecipientLock = ccc.Script.from({ codeHash: `0x${"55".repeat(32)}`, hashType: "type", args: "0x" });
  const oldDeadline = packSince(EPOCH_FRACTION_FLAG, 100n, 0n, 1n);

  const cell = buildTranfrCell({
    ownerLockHash: ownerScript.hash(),
    recipientLockHash: oldRecipientLockHash,
    deadlineSince: oldDeadline,
  });

  const client = new TranfrClient({ client: fakeClient([200n, 0n, 1n]) });

  const tx = await client.renewTranfr({
    cell,
    ownerPrivateKey: OWNER_PRIVATE_KEY,
    newRecipientLock,
  });

  const newArgs = decodeArgs(tx.outputs[0].lock.args);
  assert.equal(newArgs.recipientLockHash, newRecipientLock.hash());
  assert.notEqual(newArgs.recipientLockHash, oldRecipientLockHash);
});

test("buildOwnerReclaim signs an OWNER-mode witness that recovers to the owner's public key", async () => {
  const ownerSigner = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), OWNER_PRIVATE_KEY);
  const ownerScript = (await ownerSigner.getAddressObjSecp256k1()).script;
  const cell = buildTranfrCell({
    ownerLockHash: ownerScript.hash(),
    recipientLockHash: dummyLockHash(0x22),
    deadlineSince: packSince(EPOCH_FRACTION_FLAG, 540n, 0n, 1n),
  });
  const toLock = ccc.Script.from({ codeHash: `0x${"33".repeat(32)}`, hashType: "type", args: "0x" });
  const client = new TranfrClient({ client: fakeClient([0n, 0n, 1n]) });

  const tx = await client.buildOwnerReclaim({ cell, ownerPrivateKey: OWNER_PRIVATE_KEY, toLock });

  assert.equal(tx.inputs.length, 1);
  assert.equal(tx.inputs[0].since, 0n);
  assert.ok(tx.outputs[0].lock.eq(toLock));
  assert.ok(tx.outputs[0].capacity < cell.cellOutput.capacity, "fee must be deducted from capacity");

  const witness = decodeWitnessLock(tx.getWitnessArgs(0)!.lock!);
  assert.equal(witness.mode, UnlockMode.OWNER);

  const signInfo = await recomputeSignMessage(tx, client.client, cell.cellOutput.lock);
  assert.equal(ccc.recoverMessageSecp256k1(signInfo!.message, witness.signature), ownerSigner.publicKey);
});

test("buildOwnerReclaim still works after the recovery deadline has passed", async () => {
  const ownerSigner = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), OWNER_PRIVATE_KEY);
  const ownerScript = (await ownerSigner.getAddressObjSecp256k1()).script;
  const cell = buildTranfrCell({
    ownerLockHash: ownerScript.hash(),
    recipientLockHash: dummyLockHash(0x22),
    deadlineSince: packSince(EPOCH_FRACTION_FLAG, 10n, 0n, 1n),
  });
  const client = new TranfrClient({ client: fakeClient([999n, 0n, 1n]) });

  const tx = await client.buildOwnerReclaim({ cell, ownerPrivateKey: OWNER_PRIVATE_KEY });

  assert.equal(tx.inputs[0].since, 0n);
  assert.ok(tx.outputs[0].lock.eq(ownerScript), "defaults to the owner's own secp256k1 lock");
  assert.equal(decodeWitnessLock(tx.getWitnessArgs(0)!.lock!).mode, UnlockMode.OWNER);
});

test("buildRecoveryClaim throws client-side when the deadline has not passed", async () => {
  const cell = buildTranfrCell({
    ownerLockHash: dummyLockHash(0x11),
    recipientLockHash: dummyLockHash(0x22),
    deadlineSince: packSince(EPOCH_FRACTION_FLAG, 540n, 0n, 1n),
  });
  const client = new TranfrClient({ client: fakeClient([539n, 0n, 1n]) });

  await assert.rejects(
    () => client.buildRecoveryClaim({ cell, recipientPrivateKey: RECIPIENT_PRIVATE_KEY }),
    /not yet eligible/,
  );
});

test("buildRecoveryClaim signs a RECIPIENT-mode witness with since set to the deadline", async () => {
  const recipientSigner = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), RECIPIENT_PRIVATE_KEY);
  const recipientScript = (await recipientSigner.getAddressObjSecp256k1()).script;
  const deadlineSince = packSince(EPOCH_FRACTION_FLAG, 540n, 0n, 1n);
  const cell = buildTranfrCell({
    ownerLockHash: dummyLockHash(0x11),
    recipientLockHash: recipientScript.hash(),
    deadlineSince,
  });
  const client = new TranfrClient({ client: fakeClient([540n, 0n, 1n]) });

  const tx = await client.buildRecoveryClaim({ cell, recipientPrivateKey: RECIPIENT_PRIVATE_KEY });

  assert.equal(tx.inputs[0].since, deadlineSince);
  assert.ok(tx.outputs[0].lock.eq(recipientScript), "defaults to the recipient's own secp256k1 lock");
  assert.ok(tx.outputs[0].capacity < cell.cellOutput.capacity);

  const witness = decodeWitnessLock(tx.getWitnessArgs(0)!.lock!);
  assert.equal(witness.mode, UnlockMode.RECIPIENT);

  const signInfo = await recomputeSignMessage(tx, client.client, cell.cellOutput.lock);
  assert.equal(ccc.recoverMessageSecp256k1(signInfo!.message, witness.signature), recipientSigner.publicKey);
});
