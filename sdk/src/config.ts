import * as ccc from "@ckb-ccc/core";
import { TranfrConfig } from "./types.js";

/**
 * Official testnet deployment configuration for Tranfr (deployed in Step 10).
 * Reference: docs/deployment.md
 */
export const TRANFR_TESTNET_CONFIG: TranfrConfig = {
  codeHash: "0xffc6b1c122037a97c18878f583ab789ea7f6cf3a1febc1e02e4fd9f36c442bfd",
  hashType: "type",
  cellDep: {
    outPoint: {
      txHash: "0x0d0eb86d886c4c0f0981489498c68aba8bc914a946bbbf11ceec8c13ce442c08",
      index: 0,
    },
    depType: "code",
  },
};

/**
 * Default duration in epochs (~90 days).
 * Derived empirically from testnet and mainnet live epoch data (docs/epoch-length.md):
 * 40 transitions averaged 4.0006h on testnet -> 540 epochs ≈ 90 days.
 */
export const DEFAULT_DURATION_EPOCHS = 540n;

/**
 * Nominal hours per epoch for client-side display approximations.
 * Note: per docs/epoch-length.md, actual countdown calculations query live RPC tip
 * to track dynamic difficulty adjustments.
 */
export const NOMINAL_HOURS_PER_EPOCH = 4.0;

/**
 * Default fee rate in shannons/KB for owner-reclaim/recipient-claim/renew spends,
 * matching ckb-cli's conventional minimum fee rate.
 */
export const DEFAULT_FEE_RATE = 1000n;
