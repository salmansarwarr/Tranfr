// Tranfr lock script — scaffold stub (step 4 of implementation-plan.md).
//
// This file wires up the `since_cmp` module (ported from ckb-system-scripts
// and verified at `/reference/since-cmp-rs`) and declares the two-path
// skeleton.  Actual args/witness parsing and signature verification are added
// in steps 5–8.  This version must compile for the RISC-V target without
// warnings.

#![cfg_attr(not(any(feature = "library", test)), no_std)]
#![cfg_attr(not(test), no_main)]

#[cfg(any(feature = "library", test))]
extern crate alloc;

// Pull in the since-comparison primitives (step 2, now wired here for step 4).
// `recipient_path_eligible` is the Tranfr-specific gate; the underlying
// `epoch_number_with_fraction_cmp` and `since_value_satisfied` functions are
// also re-exported for use in the test harness (step 9).
extern crate since_cmp;
pub use since_cmp::{epoch_number_with_fraction_cmp, recipient_path_eligible, since_value_satisfied};

#[cfg(not(any(feature = "library", test)))]
ckb_std::entry!(program_entry);
#[cfg(not(any(feature = "library", test)))]
// 16 KB fixed heap + 1.2 MB dynamic heap (ckb-std defaults).
ckb_std::default_alloc!(16384, 1258306, 64);

// ── Error codes ──────────────────────────────────────────────────────────────
// These are the values the lock script will return to the CKB VM.
// 0 is success; all non-zero values are failures.
// Defined once here so steps 5–9 can reference them by name.

/// Unknown `mode` byte in `WitnessArgs.lock[0]` (not 0x00 or 0x01).
pub const ERR_UNKNOWN_MODE: i8 = 1;
/// `args` length is not exactly 72 bytes.
pub const ERR_ARGS_LEN: i8 = 2;
/// `WitnessArgs.lock` length is not exactly 66 bytes.
pub const ERR_WITNESS_LEN: i8 = 3;
/// Failed to load `WitnessArgs` (absent or malformed).
pub const ERR_LOAD_WITNESS: i8 = 4;
/// Recovered pubkey hash did not match `owner_lock_hash` (OWNER path).
pub const ERR_OWNER_SIG: i8 = 5;
/// Recovered pubkey hash did not match `recipient_lock_hash` (RECIPIENT path).
pub const ERR_RECIPIENT_SIG: i8 = 6;
/// The input's `since` value was relative-flagged (only absolute is valid on RECIPIENT path).
pub const ERR_RELATIVE_SINCE: i8 = 7;
/// The input's `since` metric was not epoch-with-fraction, or it did not reach the deadline.
pub const ERR_SINCE_NOT_ELIGIBLE: i8 = 8;
/// Failed to load the script args.
pub const ERR_LOAD_SCRIPT: i8 = 9;

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn program_entry() -> i8 {
    // Steps 5–8 will fill in:
    //   1. Load and validate script args (72 bytes → owner_hash, recipient_hash, deadline_since).
    //   2. Load and validate WitnessArgs.lock (66 bytes → mode byte + 65-byte signature).
    //   3. Dispatch on mode byte:
    //      - 0x00 OWNER path → verify secp256k1 signature against owner_lock_hash; return 0.
    //      - 0x01 RECIPIENT path → verify signature against recipient_lock_hash;
    //            load this input's `since`; call `recipient_path_eligible(input_since, deadline_since)`;
    //            return 0 iff eligible.
    //      - anything else → return ERR_UNKNOWN_MODE.
    //
    // Returning 0 here makes the stub lock unconditionally unlockable, which is
    // correct for a scaffold: it lets the test harness in step 9 load the binary
    // and run basic context checks before the real logic is in place.  The
    // contract MUST NOT be deployed to testnet until steps 5–9 are complete.
    0
}
