/**
 * Tranfr SDK — Programmable recovery for CKB self-custody
 * Built on top of CCC (@ckb-ccc/core)
 */

export * from "./types.js";
export * from "./config.js";
export * from "./client.js";

// Re-export verified fraction-safe since comparison routines from step 2
export {
  epochNumberWithFractionCmp,
  sinceValueSatisfied,
  recipientPathEligible,
  packSince,
  EPOCH_FRACTION_FLAG,
  RELATIVE_EPOCH_FRACTION_FLAG,
  ABSOLUTE_BLOCK_NUMBER_FLAG,
} from "../../reference/since-cmp-ts/since_cmp.js";
