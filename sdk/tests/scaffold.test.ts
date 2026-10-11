import test from "node:test";
import assert from "node:assert/strict";
import * as ccc from "@ckb-ccc/core";
import {
  TranfrClient,
  TRANFR_TESTNET_CONFIG,
  DEFAULT_DURATION_EPOCHS,
  UnlockMode,
  recipientPathEligible,
  packSince,
  EPOCH_FRACTION_FLAG,
} from "../src/index.js";

test("TranfrClient initializes with default testnet config", () => {
  const client = new TranfrClient();
  assert.ok(client.client instanceof ccc.ClientPublicTestnet);
  assert.equal(client.config.codeHash, TRANFR_TESTNET_CONFIG.codeHash);
  assert.equal(client.config.hashType, "type");
});

test("TranfrClient getScript generates correct Script instance", () => {
  const client = new TranfrClient();
  const dummyArgs: ccc.Hex = `0x${"00".repeat(72)}`;
  const script = client.getScript(dummyArgs);

  assert.equal(script.codeHash, TRANFR_TESTNET_CONFIG.codeHash);
  assert.equal(script.hashType, "type");
  assert.equal(script.args, dummyArgs);
});

test("TranfrClient getCellDep returns valid CellDep instance", () => {
  const client = new TranfrClient();
  const cellDep = client.getCellDep();

  assert.equal(
    cellDep.outPoint.txHash,
    "0x0d0eb86d886c4c0f0981489498c68aba8bc914a946bbbf11ceec8c13ce442c08"
  );
  assert.equal(cellDep.outPoint.index, 0n);
  assert.equal(cellDep.depType, "code");
});

test("TranfrClient accepts custom config and client", () => {
  const customConfig = {
    codeHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as ccc.Hex,
    hashType: "data1" as ccc.HashType,
    cellDep: {
      outPoint: {
        txHash: "0x2222222222222222222222222222222222222222222222222222222222222222" as ccc.Hex,
        index: 1,
      },
      depType: "code" as const,
    },
  };

  const client = new TranfrClient({ config: customConfig });
  assert.equal(client.config.codeHash, customConfig.codeHash);
  assert.equal(client.config.hashType, "data1");
  assert.equal(client.getCellDep().outPoint.index, 1n);
});

test("Enums and constants are exported correctly", () => {
  assert.equal(UnlockMode.OWNER, 0);
  assert.equal(UnlockMode.RECIPIENT, 1);
  assert.equal(DEFAULT_DURATION_EPOCHS, 540n);
});

test("Re-exported since-cmp helpers work as expected", () => {
  const deadline = packSince(EPOCH_FRACTION_FLAG, 540n, 0n, 1n);
  const eligibleSince = packSince(EPOCH_FRACTION_FLAG, 541n, 0n, 1n);
  const earlySince = packSince(EPOCH_FRACTION_FLAG, 539n, 0n, 1n);

  assert.equal(recipientPathEligible(eligibleSince, deadline), true);
  assert.equal(recipientPathEligible(earlySince, deadline), false);
});
