use ckb_testtool::ckb_error::Error;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use ckb_testtool::context::Context;

const ERR_UNKNOWN_MODE: i8 = 1;
const ERR_ARGS_LEN: i8 = 2;
const ERR_WITNESS_LEN: i8 = 3;
const ERR_LOAD_WITNESS: i8 = 4;

fn make_valid_args() -> Bytes {
    let mut args = vec![0u8; 72];
    args[0..32].fill(0x11); // owner_lock_hash
    args[32..64].fill(0x22); // recipient_lock_hash
    let deadline: u64 = 0x2000000000000050; // absolute epoch-with-fraction deadline
    args[64..72].copy_from_slice(&deadline.to_le_bytes());
    Bytes::from(args)
}

fn make_witness(lock_bytes: Option<Bytes>) -> Bytes {
    let mut builder = WitnessArgs::new_builder();
    if let Some(lb) = lock_bytes {
        builder = builder.lock(Some(lb).pack());
    }
    builder.build().as_bytes()
}

fn make_valid_witness(mode: u8) -> Bytes {
    let mut lock = vec![0u8; 66];
    lock[0] = mode;
    lock[1..66].fill(0x99); // 65-byte dummy signature
    make_witness(Some(Bytes::from(lock)))
}

fn assert_error_code(err: &Error, expected_code: i8) {
    let err_str = err.to_string();
    let expected_pattern = format!("error code {expected_code}");
    assert!(
        err_str.contains(&expected_pattern),
        "Expected error code {expected_code}, got: {err_str}"
    );
}

fn build_tx(
    context: &mut Context,
    args: Bytes,
    witness_opt: Option<Bytes>,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let out_point = context.deploy_cell_by_name("tranfr-lock");
    let lock_script = context.build_script(&out_point, args).expect("script");

    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(1000u64)
            .lock(lock_script.clone())
            .build(),
        Bytes::new(),
    );
    let input = CellInput::new_builder()
        .previous_output(input_out_point)
        .build();

    let output = CellOutput::new_builder()
        .capacity(1000u64)
        .lock(lock_script)
        .build();

    let mut tx_builder = TransactionBuilder::default()
        .input(input)
        .output(output)
        .output_data(Bytes::new().pack());

    if let Some(w) = witness_opt {
        tx_builder = tx_builder.witness(w.pack());
    }

    let tx = tx_builder.build();
    context.complete_tx(tx)
}

// ── Real-signature helpers (OWNER/RECIPIENT paths) ───────────────────────────

use ckb_testtool::ckb_hash::{blake2b_256, new_blake2b};
use k256::ecdsa::SigningKey;

const ERR_OWNER_SIG: i8 = 5;
const ERR_RECIPIENT_SIG: i8 = 6;
const ERR_RELATIVE_SINCE: i8 = 7;
const ERR_SINCE_NOT_ELIGIBLE: i8 = 8;

const SECP256K1_BLAKE160_SIGHASH_ALL_CODE_HASH: [u8; 32] = [
    0x9b, 0xd7, 0xe0, 0x6f, 0x3e, 0xcf, 0x4b, 0xe0, 0xf2, 0xfc, 0xd2, 0x18, 0x8b, 0x23, 0xf1, 0xb9,
    0xfc, 0xc8, 0x8e, 0x5d, 0x4b, 0x65, 0xa8, 0x63, 0x7b, 0x17, 0x72, 0x3b, 0xbd, 0xa3, 0xcc, 0xe8,
];

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32].into()).expect("valid scalar")
}

/// The `secp256k1_blake160_sighash_all` lock hash a wallet holding `key` has.
fn lock_hash_of(key: &SigningKey) -> [u8; 32] {
    let pubkey = key.verifying_key().to_sec1_point(true);
    let args = &blake2b_256(pubkey.as_bytes())[0..20];
    let script = Script::new_builder()
        .code_hash(SECP256K1_BLAKE160_SIGHASH_ALL_CODE_HASH.pack())
        .hash_type(ckb_testtool::ckb_types::core::ScriptHashType::Type)
        .args(Bytes::copy_from_slice(args).pack())
        .build();
    blake2b_256(script.as_slice())
}

/// Packs an RFC 0017 `since`: flags byte, then (epoch, index, length).
fn since(flags: u8, epoch: u64, index: u64, length: u64) -> u64 {
    ((flags as u64) << 56) | (length << 40) | (index << 24) | epoch
}

const ABS_EPOCH: u8 = 0x20;
const REL_EPOCH: u8 = 0xA0;

fn args_for(owner: &SigningKey, recipient: &SigningKey, deadline: u64) -> Bytes {
    let mut args = Vec::with_capacity(72);
    args.extend_from_slice(&lock_hash_of(owner));
    args.extend_from_slice(&lock_hash_of(recipient));
    args.extend_from_slice(&deadline.to_le_bytes());
    Bytes::from(args)
}

/// Builds a one-input tx with the given input `since`, signed by `signer`
/// under `mode`, using the real sighash_all message (single input/witness).
fn build_signed_tx(
    context: &mut Context,
    args: Bytes,
    mode: u8,
    signer: &SigningKey,
    input_since: u64,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let placeholder = |sig: [u8; 65]| {
        let mut lock = vec![mode];
        lock.extend_from_slice(&sig);
        make_witness(Some(Bytes::from(lock)))
    };
    let out_point = context.deploy_cell_by_name("tranfr-lock");
    let lock_script = context.build_script(&out_point, args).expect("script");
    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(1000u64)
            .lock(lock_script.clone())
            .build(),
        Bytes::new(),
    );
    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(input_out_point)
                .since(Pack::<Uint64>::pack(&input_since))
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(1000u64)
                .lock(lock_script)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .witness(placeholder([0u8; 65]).pack())
        .build();
    let tx = context.complete_tx(tx);

    // sighash_all: the script zeroes the entire 66-byte lock field (mode
    // byte included, per docs/spec.md) before hashing.
    let zeroed = make_witness(Some(Bytes::from(vec![0u8; 66])));
    let mut hasher = new_blake2b();
    hasher.update(tx.hash().as_slice());
    hasher.update(&(zeroed.len() as u64).to_le_bytes());
    hasher.update(&zeroed);
    let mut message = [0u8; 32];
    hasher.finalize(&mut message);

    let (sig, recid) = signer.sign_prehash_recoverable(&message);
    let mut sig_bytes = [0u8; 65];
    sig_bytes[0..64].copy_from_slice(&sig.to_bytes());
    sig_bytes[64] = recid.to_byte();
    tx.as_advanced_builder()
        .set_witnesses(vec![placeholder(sig_bytes).pack()])
        .build()
}

fn verify(context: &Context, tx: &ckb_testtool::ckb_types::core::TransactionView) -> Result<u64, Error> {
    context.verify_tx(tx, 100_000_000)
}

#[test]
fn test_owner_succeeds_with_no_since() {
    let (owner, recipient) = (key(1), key(2));
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, since(ABS_EPOCH, 100, 1, 4));
    let tx = build_signed_tx(&mut context, args, 0x00, &owner, 0);
    let cycles = verify(&context, &tx).expect("owner path should pass");
    println!("owner path cycles: {cycles}");
}

#[test]
fn test_owner_rejects_wrong_signer() {
    let (owner, recipient) = (key(1), key(2));
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, since(ABS_EPOCH, 100, 1, 4));
    let tx = build_signed_tx(&mut context, args, 0x00, &recipient, 0);
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_OWNER_SIG);
}

#[test]
fn test_recipient_succeeds_at_and_after_deadline() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    for input_since in [
        deadline,                       // exact boundary
        since(ABS_EPOCH, 100, 2, 8),    // equal-ratio, different denominator
        since(ABS_EPOCH, 100, 3, 4),    // later in same epoch
        since(ABS_EPOCH, 101, 0, 1),    // later epoch
    ] {
        let mut context = Context::default();
        let args = args_for(&owner, &recipient, deadline);
        let tx = build_signed_tx(&mut context, args, 0x01, &recipient, input_since);
        let cycles = verify(&context, &tx)
            .unwrap_or_else(|e| panic!("since {input_since:#x} should pass: {e}"));
        println!("recipient path cycles: {cycles}");
    }
}

#[test]
fn test_recipient_rejects_before_deadline() {
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    for input_since in [
        0,                              // no since at all
        since(ABS_EPOCH, 100, 0, 4),    // just before, same epoch
        since(ABS_EPOCH, 99, 3, 4),     // earlier epoch
        since(ABS_EPOCH, 100, 0, 0),    // degenerate zero-length early-claim
        since(0x00, 999_999, 0, 0),     // absolute block-number metric
        since(0x40, 999_999, 0, 0),     // absolute timestamp metric
    ] {
        let mut context = Context::default();
        let args = args_for(&owner, &recipient, deadline);
        let tx = build_signed_tx(&mut context, args, 0x01, &recipient, input_since);
        assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_SINCE_NOT_ELIGIBLE);
    }
}

#[test]
fn test_recipient_rejects_relative_since() {
    let (owner, recipient) = (key(1), key(2));
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, since(ABS_EPOCH, 100, 1, 4));
    let tx = build_signed_tx(&mut context, args, 0x01, &recipient, since(REL_EPOCH, 999, 0, 1));
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_RELATIVE_SINCE);
}

#[test]
fn test_recipient_rejects_malformed_deadline() {
    // A deadline that isn't absolute epoch-with-fraction is never satisfiable.
    let (owner, recipient) = (key(1), key(2));
    for bad_deadline in [since(0x00, 1, 0, 0), since(REL_EPOCH, 1, 0, 1)] {
        let mut context = Context::default();
        let args = args_for(&owner, &recipient, bad_deadline);
        let tx = build_signed_tx(&mut context, args, 0x01, &recipient, since(ABS_EPOCH, 999, 0, 1));
        assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_SINCE_NOT_ELIGIBLE);
    }
}

#[test]
fn test_recipient_rejects_wrong_signer_even_after_deadline() {
    // Owner key signing in RECIPIENT mode must not pass, nor may a valid
    // since rescue a bad signature.
    let (owner, recipient) = (key(1), key(2));
    let deadline = since(ABS_EPOCH, 100, 1, 4);
    let mut context = Context::default();
    let args = args_for(&owner, &recipient, deadline);
    let tx = build_signed_tx(&mut context, args, 0x01, &owner, since(ABS_EPOCH, 200, 0, 1));
    assert_error_code(&verify(&context, &tx).unwrap_err(), ERR_RECIPIENT_SIG);
}

#[test]
fn test_reject_invalid_args_length() {
    // Too short (1 byte)
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        Bytes::from(vec![42]),
        Some(make_valid_witness(0x00)),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_ARGS_LEN);

    // 71 bytes (1 byte short)
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        Bytes::from(vec![0u8; 71]),
        Some(make_valid_witness(0x00)),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_ARGS_LEN);

    // 73 bytes (1 byte too long)
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        Bytes::from(vec![0u8; 73]),
        Some(make_valid_witness(0x00)),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_ARGS_LEN);
}

#[test]
fn test_reject_missing_or_empty_witness() {
    // Completely missing witness
    let mut context = Context::default();
    let tx = build_tx(&mut context, make_valid_args(), None);
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_LOAD_WITNESS);

    // WitnessArgs with no lock field
    let mut context = Context::default();
    let tx = build_tx(&mut context, make_valid_args(), Some(make_witness(None)));
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_LOAD_WITNESS);
}

#[test]
fn test_reject_invalid_witness_lock_length() {
    // 65 bytes (1 byte short)
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        make_valid_args(),
        Some(make_witness(Some(Bytes::from(vec![0u8; 65])))),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_WITNESS_LEN);

    // 67 bytes (1 byte too long)
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        make_valid_args(),
        Some(make_witness(Some(Bytes::from(vec![0u8; 67])))),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_WITNESS_LEN);
}

#[test]
fn test_reject_unknown_mode_byte() {
    // Mode 0x02
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        make_valid_args(),
        Some(make_valid_witness(0x02)),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_UNKNOWN_MODE);

    // Mode 0xFF
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        make_valid_args(),
        Some(make_valid_witness(0xFF)),
    );
    let err = context.verify_tx(&tx, 10_000_000).unwrap_err();
    assert_error_code(&err, ERR_UNKNOWN_MODE);
}
