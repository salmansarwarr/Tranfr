//! Tranfr as a composition of two deployed scripts: Time Lock (ckb-proxy-locks)
//! and the Cheque lock (RFC 0039). These run the exact testnet binaries vendored
//! in `contracts/deployed/`.
//!
//! The protected CKB sits in a Cheque cell, `Cheque(receiver, sender)`. One
//! role is a plain lock, and the other is `TimeLock(recipient_lock_hash,
//! deadline)`, which only unlocks once its input's `since` reaches the deadline
//! and the recipient's own lock is among the inputs. Both role assignments are
//! tested:
//!
//! - `OwnerIsSender`: receiver = TimeLock(recipient), sender = owner.
//! - `OwnerIsReceiver`: receiver = owner, sender = TimeLock(recipient).
//!
//! Owner and recipient are always-success locks with distinct args. The
//! Cheque's "lock present in inputs" path (RFC 0039 rule 2) only checks lock
//! hashes, so no signatures are needed to exercise the rules under test.
//!
//! `ckb-testtool` runs the scripts but not consensus's own `since` check. The
//! scripts read each input's declared `since`; consensus is what stops that
//! value from being ahead of the chain.

use crate::verify_and_dump_failed_tx;
use ckb_testtool::builtin::ALWAYS_SUCCESS;
use ckb_testtool::ckb_error::Error;
use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{Cycle, ScriptHashType, TransactionBuilder},
    packed::*,
    prelude::*,
};
use ckb_testtool::context::Context;

const TIME_LOCK_BIN: &[u8] = include_bytes!("../../contracts/deployed/time-lock");
const CHEQUE_LOCK_BIN: &[u8] = include_bytes!("../../contracts/deployed/cheque-lock");

const TIME_LOCK_DATA_HASH: [u8; 32] = hex32("6fac4b2e89360a1e692efcddcb3a28656d8446549fb83da6d896db8b714f4451");
const CHEQUE_LOCK_DATA_HASH: [u8; 32] = hex32("be734faa9ead3cfeef2efba92de6b6bdb5b0cadb6cd36c896081e8cab18e79b9");

const MAX_CYCLES: u64 = 100_000_000;
const CKB: u64 = 100_000_000;
const PROTECTED: u64 = 1_000 * CKB;
const KEY_CELL: u64 = 100 * CKB;

/// RFC 0039 rule 1.c.i: the sender may withdraw only with exactly this `since`
/// (relative, epoch metric, 6 epochs after the Cheque cell was committed).
const CHEQUE_SENDER_SINCE: u64 = 0xA000_0000_0000_0006;
const DEADLINE_EPOCH: u64 = 540;

const fn hex32(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nibble(b[2 * i]) << 4) | nibble(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => panic!("bad hex"),
    }
}

/// Absolute, epoch-with-fraction `since` at the start of `epoch` (index 0, length 1).
fn epoch_since(epoch: u64) -> u64 {
    0x2000_0000_0000_0000 | (1u64 << 40) | epoch
}

#[derive(Clone, Copy)]
enum Roles {
    OwnerIsSender,
    OwnerIsReceiver,
}

struct Composition {
    context: Context,
    owner_lock: Script,
    recipient_lock: Script,
    time_lock: Script,
    cheque_lock: Script,
}

/// One transaction input plus the witness the scripts expect for it.
struct In {
    out_point: OutPoint,
    since: u64,
    witness_lock: Option<Bytes>,
}

impl Composition {
    fn new(roles: Roles) -> Self {
        let mut context = Context::default();
        let always_success = context.deploy_cell(ALWAYS_SUCCESS.clone());
        let time_lock_code = context.deploy_cell(Bytes::from_static(TIME_LOCK_BIN));
        let cheque_code = context.deploy_cell(Bytes::from_static(CHEQUE_LOCK_BIN));

        let owner_lock = context.build_script(&always_success, Bytes::from_static(b"owner")).unwrap();
        let recipient_lock = context.build_script(&always_success, Bytes::from_static(b"recipient")).unwrap();

        // Time Lock args: required lock hash (32 bytes) ‖ since (8 bytes LE). Same hash type as on chain.
        let mut time_lock_args = recipient_lock.calc_script_hash().as_bytes().to_vec();
        time_lock_args.extend_from_slice(&epoch_since(DEADLINE_EPOCH).to_le_bytes());
        let time_lock = context
            .build_script_with_hash_type(&time_lock_code, ScriptHashType::Data1, time_lock_args.into())
            .unwrap();

        // Cheque args: 20-byte receiver lock hash ‖ 20-byte sender lock hash (RFC 0039).
        let (receiver, sender) = match roles {
            Roles::OwnerIsSender => (&time_lock, &owner_lock),
            Roles::OwnerIsReceiver => (&owner_lock, &time_lock),
        };
        let mut cheque_args = receiver.calc_script_hash().as_bytes()[0..20].to_vec();
        cheque_args.extend_from_slice(&sender.calc_script_hash().as_bytes()[0..20]);
        let cheque_lock = context.build_script(&cheque_code, cheque_args.into()).unwrap();

        Self { context, owner_lock, recipient_lock, time_lock, cheque_lock }
    }

    fn cell(&mut self, lock: &Script, capacity: u64) -> OutPoint {
        self.context.create_cell(
            CellOutput::new_builder().capacity(capacity).lock(lock.clone()).build(),
            Bytes::new(),
        )
    }

    fn protected_cell(&mut self) -> OutPoint {
        let lock = self.cheque_lock.clone();
        self.cell(&lock, PROTECTED)
    }

    fn time_lock_cell(&mut self) -> OutPoint {
        let lock = self.time_lock.clone();
        self.cell(&lock, KEY_CELL)
    }

    fn owner_cell(&mut self) -> OutPoint {
        let lock = self.owner_lock.clone();
        self.cell(&lock, KEY_CELL)
    }

    fn recipient_cell(&mut self) -> OutPoint {
        let lock = self.recipient_lock.clone();
        self.cell(&lock, KEY_CELL)
    }

    fn verify(&mut self, inputs: Vec<In>, outputs: Vec<(&Script, u64)>) -> Result<Cycle, Error> {
        let mut builder = TransactionBuilder::default();
        for input in &inputs {
            builder = builder
                .input(
                    CellInput::new_builder()
                        .previous_output(input.out_point.clone())
                        .since(Pack::<Uint64>::pack(&input.since))
                        .build(),
                )
                .witness(
                    WitnessArgs::new_builder()
                        .lock(input.witness_lock.clone().pack())
                        .build()
                        .as_bytes()
                        .pack(),
                );
        }
        for (lock, capacity) in outputs {
            builder = builder
                .output(CellOutput::new_builder().capacity(capacity).lock(lock.clone()).build())
                .output_data(Bytes::new().pack());
        }
        let tx = self.context.complete_tx(builder.build());
        verify_and_dump_failed_tx(&self.context, &tx, MAX_CYCLES)
    }
}

/// Cheque rule 2.b wants a non-empty witness lock on the input that proves the receiver role.
fn proof_witness() -> Option<Bytes> {
    Some(Bytes::from(vec![0u8; 65]))
}

fn plain(out_point: OutPoint, since: u64) -> In {
    In { out_point, since, witness_lock: None }
}

fn proving(out_point: OutPoint, since: u64) -> In {
    In { out_point, since, witness_lock: proof_witness() }
}

#[test]
fn vendored_binaries_match_the_deployed_cells() {
    assert_eq!(CellOutput::calc_data_hash(TIME_LOCK_BIN).as_slice(), &TIME_LOCK_DATA_HASH);
    assert_eq!(CellOutput::calc_data_hash(CHEQUE_LOCK_BIN).as_slice(), &CHEQUE_LOCK_DATA_HASH);
}

// ── Roles::OwnerIsSender: receiver = TimeLock(recipient), sender = owner ─────────

/// Owner withdraws as Cheque sender, sending the CKB wherever they like.
/// Nothing in the owner path reads the Time Lock deadline, so this
/// transaction is equally valid before or after it.
#[test]
fn owner_access_before_and_after_the_deadline() {
    let mut c = Composition::new(Roles::OwnerIsSender);
    let protected = c.protected_cell();
    let owner = c.owner_cell();
    let owner_lock = c.owner_lock.clone();

    c.verify(
        vec![plain(protected, CHEQUE_SENDER_SINCE), proving(owner, 0)],
        vec![(&owner_lock, PROTECTED + KEY_CELL)],
    )
    .expect("owner withdraws as Cheque sender");
}

/// Contrary to "the owner can always take the assets": the Cheque sender
/// path only accepts `since = 0xA000000000000006`, so the owner is locked out
/// for 6 epochs (~24h) after every create or renew.
#[test]
fn owner_is_locked_out_for_six_epochs_after_each_create_or_renew() {
    let mut c = Composition::new(Roles::OwnerIsSender);
    let protected = c.protected_cell();
    let owner = c.owner_cell();
    let owner_lock = c.owner_lock.clone();

    let err = c
        .verify(vec![plain(protected, 0), proving(owner, 0)], vec![(&owner_lock, PROTECTED + KEY_CELL)])
        .expect_err("the Cheque sender path must reject an immediate withdrawal");
    // Cheque error 11 = WithdrawChequeInputSinceError.
    assert!(err.to_string().contains("error code 11"), "expected Cheque error 11, got: {err}");
}

/// Recipient claims with everything set up correctly except the time:
/// the Time Lock input's `since` is one epoch short of the deadline.
#[test]
fn recipient_blocked_before_the_deadline() {
    let mut c = Composition::new(Roles::OwnerIsSender);
    let protected = c.protected_cell();
    let key = c.time_lock_cell();
    let recipient = c.recipient_cell();
    let (owner_lock, recipient_lock) = (c.owner_lock.clone(), c.recipient_lock.clone());

    let err = c
        .verify(
            vec![plain(protected, 0), proving(key, epoch_since(DEADLINE_EPOCH - 1)), plain(recipient, 0)],
            vec![(&owner_lock, PROTECTED), (&recipient_lock, 2 * KEY_CELL)],
        )
        .expect_err("Time Lock must reject before the deadline");
    assert!(err.to_string().contains("Inputs[1].Lock"), "expected the Time Lock input to fail, got: {err}");
}

/// At and after the deadline the recipient's claim is accepted, but only
/// because the Cheque capacity is sent to the owner (RFC 0039 rule 1.b.ii).
#[test]
fn recipient_allowed_at_and_after_the_deadline() {
    for epoch in [DEADLINE_EPOCH, DEADLINE_EPOCH + 10] {
        let mut c = Composition::new(Roles::OwnerIsSender);
        let protected = c.protected_cell();
        let key = c.time_lock_cell();
        let recipient = c.recipient_cell();
        let (owner_lock, recipient_lock) = (c.owner_lock.clone(), c.recipient_lock.clone());

        c.verify(
            vec![plain(protected, 0), proving(key, epoch_since(epoch)), plain(recipient, 0)],
            vec![(&owner_lock, PROTECTED), (&recipient_lock, 2 * KEY_CELL)],
        )
        .unwrap_or_else(|err| panic!("claim at epoch {epoch} should pass: {err}"));
    }
}

/// THE KEY QUESTION. Tranfr needs the recipient's claim to pay the protected
/// CKB to the recipient. This test states that requirement. If RFC 0039 rule
/// 1.b.ii holds (the Cheque capacity must go back to the sender, i.e. the
/// owner), this test FAILS with Cheque error 8 (`SenderCapacityNotSame`), and
/// the composition cannot deliver plain CKB to the recipient.
#[test]
fn recipient_claim_pays_the_protected_ckb_to_the_recipient() {
    let mut c = Composition::new(Roles::OwnerIsSender);
    let protected = c.protected_cell();
    let key = c.time_lock_cell();
    let recipient = c.recipient_cell();
    let recipient_lock = c.recipient_lock.clone();

    c.verify(
        vec![plain(protected, 0), proving(key, epoch_since(DEADLINE_EPOCH)), plain(recipient, 0)],
        vec![(&recipient_lock, PROTECTED + 2 * KEY_CELL)],
    )
    .expect("the recipient's claim should pay the protected CKB to the recipient");
}

// ── Roles::OwnerIsReceiver: receiver = owner, sender = TimeLock(recipient) ───────

/// With the roles swapped, the recipient can take the CKB after the deadline...
#[test]
fn swapped_roles_recipient_takes_the_ckb_after_the_deadline() {
    let mut c = Composition::new(Roles::OwnerIsReceiver);
    let protected = c.protected_cell();
    let key = c.time_lock_cell();
    let recipient = c.recipient_cell();
    let recipient_lock = c.recipient_lock.clone();

    c.verify(
        vec![plain(protected, CHEQUE_SENDER_SINCE), proving(key, epoch_since(DEADLINE_EPOCH)), plain(recipient, 0)],
        vec![(&recipient_lock, PROTECTED + 2 * KEY_CELL)],
    )
    .expect("recipient withdraws as Cheque sender after the deadline");
}

/// ...but then the owner, now the Cheque receiver, must send the CKB to the
/// sender's lock, the recipient's Time Lock. This test states the requirement
/// "the owner can always take their own assets" and is expected to FAIL with
/// Cheque error 8 (`SenderCapacityNotSame`).
#[test]
fn swapped_roles_owner_takes_their_own_ckb() {
    let mut c = Composition::new(Roles::OwnerIsReceiver);
    let protected = c.protected_cell();
    let owner = c.owner_cell();
    let owner_lock = c.owner_lock.clone();

    c.verify(
        vec![plain(protected, 0), proving(owner, 0)],
        vec![(&owner_lock, PROTECTED + KEY_CELL)],
    )
    .expect("the owner should be able to take their own CKB");
}
