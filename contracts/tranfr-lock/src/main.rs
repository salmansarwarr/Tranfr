// Tranfr lock script — step 5: args and witness parsing.
//
// This file implements fixed-width hand-rolled parsing of:
//   1. Script args (72 bytes: owner_lock_hash (32B) + recipient_lock_hash (32B) + deadline_since (8B, LE u64))
//   2. WitnessArgs.lock (66 bytes: mode (1B: 0x00=OWNER, 0x01=RECIPIENT) + signature (65B))
//
// Syscalls used:
//   - ckb_std::high_level::load_script
//   - ckb_std::high_level::load_witness_args(0, Source::GroupInput)

#![cfg_attr(not(any(feature = "library", test)), no_std)]
#![cfg_attr(not(test), no_main)]

#[cfg(any(feature = "library", test))]
extern crate alloc;

// Pull in the since-comparison primitives (step 2, wired in step 4).
extern crate since_cmp;
pub use since_cmp::{epoch_number_with_fraction_cmp, recipient_path_eligible, since_value_satisfied};

use ckb_std::ckb_constants::Source;
#[allow(unused_imports)]
use ckb_std::ckb_types::prelude::*;
use ckb_std::high_level::{load_script, load_witness_args};

#[cfg(not(any(feature = "library", test)))]
ckb_std::entry!(program_entry);
#[cfg(not(any(feature = "library", test)))]
// 16 KB fixed heap + 1.2 MB dynamic heap (ckb-std defaults).
ckb_std::default_alloc!(16384, 1258306, 64);

// ── Error codes ──────────────────────────────────────────────────────────────
// These are the values the lock script will return to the CKB VM.
// 0 is success; all non-zero values are failures.

/// Unknown `mode` byte in `WitnessArgs.lock[0]` (not 0x00 or 0x01).
pub const ERR_UNKNOWN_MODE: i8 = 1;
/// `args` length is not exactly 72 bytes.
pub const ERR_ARGS_LEN: i8 = 2;
/// `WitnessArgs.lock` length is not exactly 66 bytes.
pub const ERR_WITNESS_LEN: i8 = 3;
/// Failed to load `WitnessArgs` (absent, empty, or malformed).
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

// ── Layout constants ──────────────────────────────────────────────────────────

/// Fixed width of Tranfr lock script args: 32 + 32 + 8 = 72 bytes.
pub const ARGS_LEN: usize = 72;

/// Fixed width of Tranfr WitnessArgs.lock: 1 + 65 = 66 bytes.
pub const WITNESS_LOCK_LEN: usize = 66;

// ── Parsed types ─────────────────────────────────────────────────────────────

/// Parsed 72-byte Tranfr script args.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct TranfrArgs {
    pub owner_lock_hash: [u8; 32],
    pub recipient_lock_hash: [u8; 32],
    pub deadline_since: u64,
}

/// Unlock mode indicated by `WitnessArgs.lock[0]`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum UnlockMode {
    Owner = 0x00,
    Recipient = 0x01,
}

/// Parsed 66-byte Tranfr witness lock field.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct TranfrWitness {
    pub mode: UnlockMode,
    pub signature: [u8; 65],
}

// ── Parsing functions ────────────────────────────────────────────────────────

/// Parses and validates Tranfr lock args from raw bytes.
/// Returns ERR_ARGS_LEN if the slice is not exactly 72 bytes.
pub fn parse_tranfr_args(args: &[u8]) -> Result<TranfrArgs, i8> {
    if args.len() != ARGS_LEN {
        return Err(ERR_ARGS_LEN);
    }

    let mut owner_lock_hash = [0u8; 32];
    owner_lock_hash.copy_from_slice(&args[0..32]);

    let mut recipient_lock_hash = [0u8; 32];
    recipient_lock_hash.copy_from_slice(&args[32..64]);

    let deadline_bytes: [u8; 8] = match args[64..72].try_into() {
        Ok(b) => b,
        Err(_) => return Err(ERR_ARGS_LEN),
    };
    let deadline_since = u64::from_le_bytes(deadline_bytes);

    Ok(TranfrArgs {
        owner_lock_hash,
        recipient_lock_hash,
        deadline_since,
    })
}

/// Parses and validates the lock field from WitnessArgs.
/// Returns ERR_WITNESS_LEN if not exactly 66 bytes.
/// Returns ERR_UNKNOWN_MODE if mode byte is not 0x00 (Owner) or 0x01 (Recipient).
pub fn parse_tranfr_witness_lock(lock_bytes: &[u8]) -> Result<TranfrWitness, i8> {
    if lock_bytes.len() != WITNESS_LOCK_LEN {
        return Err(ERR_WITNESS_LEN);
    }

    let mode = match lock_bytes[0] {
        0x00 => UnlockMode::Owner,
        0x01 => UnlockMode::Recipient,
        _ => return Err(ERR_UNKNOWN_MODE),
    };

    let mut signature = [0u8; 65];
    signature.copy_from_slice(&lock_bytes[1..66]);

    Ok(TranfrWitness { mode, signature })
}

/// Loads the current script via syscall and parses Tranfr args from it.
pub fn load_and_parse_args() -> Result<TranfrArgs, i8> {
    let script = load_script().map_err(|_| ERR_LOAD_SCRIPT)?;
    let args = script.args().raw_data();
    parse_tranfr_args(args.as_ref())
}

/// Loads WitnessArgs for the first input in the script group and parses the lock field.
pub fn load_and_parse_witness() -> Result<TranfrWitness, i8> {
    let witness_args = load_witness_args(0, Source::GroupInput)
        .map_err(|_| ERR_LOAD_WITNESS)?;
    let lock_opt = witness_args.lock().to_opt().ok_or(ERR_LOAD_WITNESS)?;
    let lock_bytes = lock_opt.raw_data();
    parse_tranfr_witness_lock(lock_bytes.as_ref())
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn program_entry() -> i8 {
    let _args = match load_and_parse_args() {
        Ok(args) => args,
        Err(err) => return err,
    };

    let _witness = match load_and_parse_witness() {
        Ok(witness) => witness,
        Err(err) => return err,
    };

    // Step 5: Args and witness parsing complete and validated.
    // Steps 6–8 will dispatch on mode and verify signature / check since.
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_tranfr_args_valid() {
        let mut args = [0u8; 72];
        args[0..32].fill(0xAA);
        args[32..64].fill(0xBB);
        let deadline = 0x2000000000000050u64; // epoch-with-fraction absolute since
        args[64..72].copy_from_slice(&deadline.to_le_bytes());

        let parsed = parse_tranfr_args(&args).expect("valid args");
        assert_eq!(parsed.owner_lock_hash, [0xAA; 32]);
        assert_eq!(parsed.recipient_lock_hash, [0xBB; 32]);
        assert_eq!(parsed.deadline_since, deadline);
    }

    #[test]
    fn test_parse_tranfr_args_invalid_len() {
        assert_eq!(parse_tranfr_args(&[]).unwrap_err(), ERR_ARGS_LEN);
        assert_eq!(parse_tranfr_args(&[0u8; 71]).unwrap_err(), ERR_ARGS_LEN);
        assert_eq!(parse_tranfr_args(&[0u8; 73]).unwrap_err(), ERR_ARGS_LEN);
    }

    #[test]
    fn test_parse_tranfr_witness_lock_valid() {
        let mut lock = [0u8; 66];
        lock[0] = 0x00; // Owner
        lock[1..66].fill(0x11);
        let parsed_owner = parse_tranfr_witness_lock(&lock).expect("valid owner witness");
        assert_eq!(parsed_owner.mode, UnlockMode::Owner);
        assert_eq!(parsed_owner.signature, [0x11; 65]);

        lock[0] = 0x01; // Recipient
        let parsed_recipient = parse_tranfr_witness_lock(&lock).expect("valid recipient witness");
        assert_eq!(parsed_recipient.mode, UnlockMode::Recipient);
        assert_eq!(parsed_recipient.signature, [0x11; 65]);
    }

    #[test]
    fn test_parse_tranfr_witness_lock_invalid_len() {
        assert_eq!(parse_tranfr_witness_lock(&[]).unwrap_err(), ERR_WITNESS_LEN);
        assert_eq!(parse_tranfr_witness_lock(&[0u8; 65]).unwrap_err(), ERR_WITNESS_LEN);
        assert_eq!(parse_tranfr_witness_lock(&[0u8; 67]).unwrap_err(), ERR_WITNESS_LEN);
    }

    #[test]
    fn test_parse_tranfr_witness_lock_unknown_mode() {
        let mut lock = [0u8; 66];
        lock[0] = 0x02;
        assert_eq!(parse_tranfr_witness_lock(&lock).unwrap_err(), ERR_UNKNOWN_MODE);
        lock[0] = 0xFF;
        assert_eq!(parse_tranfr_witness_lock(&lock).unwrap_err(), ERR_UNKNOWN_MODE);
    }
}
