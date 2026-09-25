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

#[test]
fn test_valid_args_and_owner_witness() {
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        make_valid_args(),
        Some(make_valid_witness(0x00)),
    );
    let cycles = context
        .verify_tx(&tx, 10_000_000)
        .expect("should pass verification");
    println!("valid owner witness consume cycles: {}", cycles);
}

#[test]
fn test_valid_args_and_recipient_witness() {
    let mut context = Context::default();
    let tx = build_tx(
        &mut context,
        make_valid_args(),
        Some(make_valid_witness(0x01)),
    );
    let cycles = context
        .verify_tx(&tx, 10_000_000)
        .expect("should pass verification");
    println!("valid recipient witness consume cycles: {}", cycles);
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
