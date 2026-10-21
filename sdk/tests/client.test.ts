import test from "node:test";
import assert from "node:assert/strict";
import * as ccc from "@ckb-ccc/core";
import {
  TranfrClient,
  TRANFR_TESTNET_CONFIG,
  DEFAULT_DURATION_EPOCHS,
  UnlockMode,
  decodeArgs,
  decodeWitnessLock,
  packSince,
  EPOCH_FRACTION_FLAG,
  WITNESS_LOCK_LEN,
  SECP256K1_BLAKE160_CODE_HASH,
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
    // Epoch of the block that committed every transaction; unset = not found on chain.
    private readonly commitEpoch?: ccc.EpochLike,
  ) {}

  async getTransaction() {
    return this.commitEpoch === undefined ? undefined : { blockHash: `0x${"cc".repeat(32)}` };
  }

  async getHeaderByHash() {
    return this.commitEpoch === undefined ? undefined : { epoch: ccc.Epoch.from(this.commitEpoch) };
  }

  get addressPrefix() {
    return this.testnet.addressPrefix;
  }

  getKnownScript(script: ccc.KnownScript) {
    return this.testnet.getKnownScript(script);
  }

  async getTipHeader() {
    return { epoch: ccc.Epoch.from(this.tipEpoch) } as unknown as ccc.ClientBlockHeader;
  }

  // `cells` models the live cell set: anything absent is unknown or already spent.
  async getCellLive(outPointLike: ccc.OutPointLike) {
    const outPoint = ccc.OutPoint.from(outPointLike);
    return this.cells.get(`${outPoint.txHash}:${outPoint.index}`);
  }

  async getCell(): Promise<ccc.Cell | undefined> {
    throw new Error("status must not use getCell: it also returns spent cells");
  }
}

function fakeClient(tipEpoch: ccc.EpochLike, cells?: Map<string, ccc.Cell>, commitEpoch?: ccc.EpochLike): ccc.Client {
  return new FakeClient(tipEpoch, cells, commitEpoch) as unknown as ccc.Client;
}

async function secp256k1LockOf(privateKey: ccc.Hex): Promise<ccc.Script> {
  return (await new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), privateKey).getAddressObjSecp256k1()).script;
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

function buildTranfrCell(
  args: { ownerLockHash: ccc.Hex; recipientLockHash: ccc.Hex; deadlineSince: bigint },
  capacity = 200_00000000n,
  extra: { type?: ccc.ScriptLike; outputData?: ccc.HexLike } = {},
) {
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
    cellOutput: { capacity, lock, type: extra.type },
    outputData: extra.outputData ?? "0x",
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

test("getTranfrStatus throws when the cell is not live (missing or already spent)", async () => {
  const client = new TranfrClient({ client: fakeClient([0n, 0n, 1n]) });
  await assert.rejects(
    () => client.getTranfrStatus({ txHash: `0x${"00".repeat(32)}`, index: 0 }),
    /not found or already spent/,
  );
});

test("createTranfr builds an output encoding currentEpoch + durationEpochs as the deadline", async () => {
  const client = new TranfrClient({ client: fakeClient([100n, 0n, 1n]) });
  const ownerLock = await secp256k1LockOf(OWNER_PRIVATE_KEY);
  const recipientLock = await secp256k1LockOf(RECIPIENT_PRIVATE_KEY);

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

  const client = new TranfrClient({ client: fakeClient([200n, 0n, 1n], undefined, [50n, 0n, 1n]) });

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
  const newRecipientLock = await secp256k1LockOf(RECIPIENT_PRIVATE_KEY);
  const oldDeadline = packSince(EPOCH_FRACTION_FLAG, 100n, 0n, 1n);

  const cell = buildTranfrCell({
    ownerLockHash: ownerScript.hash(),
    recipientLockHash: oldRecipientLockHash,
    deadlineSince: oldDeadline,
  });

  const client = new TranfrClient({ client: fakeClient([200n, 0n, 1n], undefined, [50n, 0n, 1n]) });

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

test("renewTranfr refuses to deduct a fee that would leave the cell below its minimum capacity", async () => {
  const ownerSigner = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), OWNER_PRIVATE_KEY);
  const ownerScript = (await ownerSigner.getAddressObjSecp256k1()).script;
  // 113 CKB is exactly the occupied size of a Tranfr cell (8 + 32 + 1 + 72 bytes), so any fee breaks it.
  const cell = buildTranfrCell(
    {
      ownerLockHash: ownerScript.hash(),
      recipientLockHash: dummyLockHash(0x22),
      deadlineSince: packSince(EPOCH_FRACTION_FLAG, 100n, 0n, 1n),
    },
    113_00000000n,
  );
  assert.equal(cell.cellOutput.capacity, 113_00000000n);
  const client = new TranfrClient({ client: fakeClient([200n, 0n, 1n], undefined, [50n, 0n, 1n]) });

  await assert.rejects(
    () => client.renewTranfr({ cell, ownerPrivateKey: OWNER_PRIVATE_KEY }),
    /minimum of 113 CKB/,
  );
});

const NON_SECP256K1_LOCKS: Array<[string, ccc.ScriptLike]> = [
  ["a different lock (e.g. JoyID/Omnilock)", { codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: `0x${"aa".repeat(20)}` }],
  ["the secp256k1 code hash with hash_type data1", { codeHash: SECP256K1_BLAKE160_CODE_HASH, hashType: "data1", args: `0x${"aa".repeat(20)}` }],
  ["the secp256k1 code hash with non-20-byte args", { codeHash: SECP256K1_BLAKE160_CODE_HASH, hashType: "type", args: `0x${"aa".repeat(21)}` }],
];

test("createTranfr refuses owner or recipient locks the script could never verify", async () => {
  const client = new TranfrClient({ client: fakeClient([100n, 0n, 1n]) });
  const validLock = await secp256k1LockOf(OWNER_PRIVATE_KEY);

  for (const [label, badLock] of NON_SECP256K1_LOCKS) {
    await assert.rejects(
      () => client.createTranfr({ ownerLock: badLock, recipientLock: validLock, capacity: 300_00000000n }),
      /owner lock must be a standard secp256k1_blake160 lock/,
      `owner: ${label}`,
    );
    await assert.rejects(
      () => client.createTranfr({ ownerLock: validLock, recipientLock: badLock, capacity: 300_00000000n }),
      /recipient lock must be a standard secp256k1_blake160 lock/,
      `recipient: ${label}`,
    );
  }
});

test("renewTranfr refuses a new recipient lock the script could never verify", async () => {
  const ownerScript = await secp256k1LockOf(OWNER_PRIVATE_KEY);
  const cell = buildTranfrCell({
    ownerLockHash: ownerScript.hash(),
    recipientLockHash: dummyLockHash(0x22),
    deadlineSince: packSince(EPOCH_FRACTION_FLAG, 100n, 0n, 1n),
  });
  const client = new TranfrClient({ client: fakeClient([200n, 0n, 1n], undefined, [50n, 0n, 1n]) });

  for (const [label, badLock] of NON_SECP256K1_LOCKS) {
    await assert.rejects(
      () => client.renewTranfr({ cell, ownerPrivateKey: OWNER_PRIVATE_KEY, newRecipientLock: badLock }),
      /recipient lock must be a standard secp256k1_blake160 lock/,
      label,
    );
  }
});

const UDT_TYPE: ccc.ScriptLike = { codeHash: `0x${"77".repeat(32)}`, hashType: "type", args: `0x${"88".repeat(32)}` };
const UDT_AMOUNT: ccc.Hex = `0x${"01".padEnd(32, "0")}`;
const UDT_CELL_DEP: ccc.CellDepLike = {
  outPoint: { txHash: `0x${"99".repeat(32)}`, index: 0 },
  depType: "code",
};

async function buildTypedCell() {
  const ownerScript = await secp256k1LockOf(OWNER_PRIVATE_KEY);
  const recipientScript = await secp256k1LockOf(RECIPIENT_PRIVATE_KEY);
  return buildTranfrCell(
    {
      ownerLockHash: ownerScript.hash(),
      recipientLockHash: recipientScript.hash(),
      deadlineSince: packSince(EPOCH_FRACTION_FLAG, 540n, 0n, 1n),
    },
    300_00000000n,
    { type: UDT_TYPE, outputData: UDT_AMOUNT },
  );
}

function assertKeepsTypeAndData(tx: ccc.Transaction) {
  assert.ok(tx.outputs[0].type?.eq(UDT_TYPE), "type script must be preserved");
  assert.equal(tx.outputsData[0], UDT_AMOUNT, "cell data must be preserved");
  assert.ok(
    tx.cellDeps.some((dep) => dep.eq(ccc.CellDep.from(UDT_CELL_DEP))),
    "the type script's cell dep must be included before signing",
  );
}

test("renew, reclaim and claim keep a typed cell's type script and data", async () => {
  const cell = await buildTypedCell();
  const client = new TranfrClient({ client: fakeClient([600n, 0n, 1n], undefined, [0n, 0n, 1n]) });

  assertKeepsTypeAndData(
    await client.renewTranfr({ cell, ownerPrivateKey: OWNER_PRIVATE_KEY, cellDeps: [UDT_CELL_DEP] }),
  );
  assertKeepsTypeAndData(
    await client.buildOwnerReclaim({ cell, ownerPrivateKey: OWNER_PRIVATE_KEY, cellDeps: [UDT_CELL_DEP] }),
  );
  assertKeepsTypeAndData(
    await client.buildRecoveryClaim({ cell, recipientPrivateKey: RECIPIENT_PRIVATE_KEY, cellDeps: [UDT_CELL_DEP] }),
  );
});

test("spending a typed cell without its cell deps is refused before signing", async () => {
  const cell = await buildTypedCell();
  const client = new TranfrClient({ client: fakeClient([600n, 0n, 1n], undefined, [0n, 0n, 1n]) });
  const missingDeps = /has a type script; pass that script's cell deps/;

  await assert.rejects(() => client.renewTranfr({ cell, ownerPrivateKey: OWNER_PRIVATE_KEY }), missingDeps);
  await assert.rejects(() => client.buildOwnerReclaim({ cell, ownerPrivateKey: OWNER_PRIVATE_KEY }), missingDeps);
  await assert.rejects(
    () => client.buildRecoveryClaim({ cell, recipientPrivateKey: RECIPIENT_PRIVATE_KEY }),
    missingDeps,
  );
});

async function renewedDeadline(
  { deadline, tip, createdAt }: { deadline: bigint; tip: bigint; createdAt?: bigint },
  extra: { newDurationEpochs?: bigint; allowEarlierDeadline?: boolean } = {},
): Promise<bigint> {
  const ownerScript = await secp256k1LockOf(OWNER_PRIVATE_KEY);
  const cell = buildTranfrCell({
    ownerLockHash: ownerScript.hash(),
    recipientLockHash: dummyLockHash(0x22),
    deadlineSince: packSince(EPOCH_FRACTION_FLAG, deadline, 0n, 1n),
  });
  const commitEpoch = createdAt === undefined ? undefined : ([createdAt, 0n, 1n] as ccc.EpochLike);
  const client = new TranfrClient({ client: fakeClient([tip, 0n, 1n], undefined, commitEpoch) });
  const tx = await client.renewTranfr({ cell, ownerPrivateKey: OWNER_PRIVATE_KEY, ...extra });
  return decodeArgs(tx.outputs[0].lock.args).deadlineSince;
}

test("renewTranfr by default keeps a longer period instead of shortening it to 90 days", async () => {
  // Created at epoch 100 with a 1080-epoch (~180 day) period; renewed at epoch 300.
  const deadline = await renewedDeadline({ deadline: 1180n, tip: 300n, createdAt: 100n });
  assert.equal(deadline, packSince(EPOCH_FRACTION_FLAG, 300n + 1080n, 0n, 1n));
});

test("renewTranfr by default never renews for less than the 90-day default", async () => {
  // A 1-epoch demo cell renews for DEFAULT_DURATION_EPOCHS, not 1 epoch.
  const deadline = await renewedDeadline({ deadline: 101n, tip: 101n, createdAt: 100n });
  assert.equal(deadline, packSince(EPOCH_FRACTION_FLAG, 101n + DEFAULT_DURATION_EPOCHS, 0n, 1n));
});

test("renewTranfr refuses an explicit duration that would move the deadline earlier, unless allowed", async () => {
  const cell = { deadline: 1180n, tip: 300n, createdAt: 100n };
  await assert.rejects(() => renewedDeadline(cell, { newDurationEpochs: 540n }), /would move the deadline earlier/);

  const deadline = await renewedDeadline(cell, { newDurationEpochs: 540n, allowEarlierDeadline: true });
  assert.equal(deadline, packSince(EPOCH_FRACTION_FLAG, 300n + 540n, 0n, 1n));
});

test("renewTranfr without a duration fails clearly if the cell's creation block can't be found", async () => {
  await assert.rejects(
    () => renewedDeadline({ deadline: 1180n, tip: 300n }),
    /pass newDurationEpochs explicitly/,
  );
  // An explicit duration doesn't need the creation block.
  const deadline = await renewedDeadline({ deadline: 1180n, tip: 300n }, { newDurationEpochs: 1080n });
  assert.equal(deadline, packSince(EPOCH_FRACTION_FLAG, 300n + 1080n, 0n, 1n));
});
