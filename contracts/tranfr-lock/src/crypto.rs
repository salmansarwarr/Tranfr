// Tranfr lock script — step 6: OWNER-path signature verification, plus the
// shared crypto machinery both paths use (recipient's since-gate is step 7).
//
// This ports the exact algorithm of `secp256k1_blake160_sighash_all.c`
// (nervosnetwork/ckb-system-scripts), adapted for Tranfr's 66-byte
// WitnessArgs.lock field (mode byte + 65-byte signature) instead of the
// standard lock's bare 65-byte signature, and for comparing against a
// 32-byte lock-script hash (`docs/spec.md` §2-3) instead of a 20-byte
// blake160 pubkey hash directly.
//
// Message construction (verbatim algorithm, see the doc comment at the top
// of secp256k1_blake160_sighash_all.c):
//   blake2b("ckb-default-hash") of:
//     1. the transaction hash;
//     2. this script's first-group-input witness, parsed as WitnessArgs,
//        with the `lock` field zero-filled, length-prefixed (u64 LE);
//     3. every other group-input witness (same lock script, later inputs),
//        each length-prefixed, unmodified;
//     4. every witness whose index is >= the total input count (extra
//        witnesses with no matching input cell), each length-prefixed,
//        unmodified.
//
// Recovery + comparison:
//   recover the pubkey from (message, signature) with k256, serialize it
//   SEC1-compressed (33 bytes, matching CKB's own pubkey convention),
//   blake160 it (blake2b, first 20 bytes), build the *implied*
//   secp256k1_blake160_sighash_all Script{code_hash, hash_type: Type,
//   args: blake160} molecule bytes, and blake2b-hash *that* to get a
//   32-byte lock hash comparable against Tranfr's own args (`docs/spec.md`
//   §3: this assumes the owner/recipient's real-world wallet is a standard
//   default-lock account, since that's the convention this signing scheme
//   borrows).

use alloc::vec;

use ckb_hash::new_blake2b;
use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::{bytes::Bytes, packed, prelude::*};
use ckb_std::error::SysError;
use ckb_std::high_level::{load_input_since, load_tx_hash, load_witness};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use crate::{
    ERR_CALCULATE_INPUTS, ERR_LOAD_TX_HASH, ERR_SECP_PARSE_SIGNATURE, ERR_SECP_RECOVER_PUBKEY,
    ERR_SIGHASH_WITNESS, WITNESS_LOCK_LEN,
};

/// `secp256k1_blake160_sighash_all` code hash, `hash_type = Type`.
/// Identical on mainnet (Lina) and testnet (Pudge) — confirmed against
/// docs.nervos.org's ecosystem-scripts reference.
pub const SECP256K1_BLAKE160_SIGHASH_ALL_CODE_HASH: [u8; 32] = [
    0x9b, 0xd7, 0xe0, 0x6f, 0x3e, 0xcf, 0x4b, 0xe0, 0xf2, 0xfc, 0xd2, 0x18, 0x8b, 0x23, 0xf1, 0xb9,
    0xfc, 0xc8, 0x8e, 0x5d, 0x4b, 0x65, 0xa8, 0x63, 0x7b, 0x17, 0x72, 0x3b, 0xbd, 0xa3, 0xcc, 0xe8,
];

/// `ScriptHashType::Type` as its raw molecule `Byte` value (1). Hand-coded
/// rather than imported from `ckb_types::core::ScriptHashType` so this
/// module only depends on `packed` + `prelude`, which are present in every
/// `ckb_types` configuration this crate builds with.
const SCRIPT_HASH_TYPE_TYPE: u8 = 1;

/// Counts total input cells by probing `load_input_since` until
/// `IndexOutOfBound`. Mirrors `calculate_inputs_len()` in
/// ckb-system-scripts' `common.h`, reusing an existing high_level call
/// instead of a raw syscall.
fn calculate_inputs_len() -> Result<usize, i8> {
    let mut i = 0usize;
    loop {
        match load_input_since(i, Source::Input) {
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => return Ok(i),
            Err(_) => return Err(ERR_CALCULATE_INPUTS),
        }
    }
}

/// Builds the exact sighash_all-style message for the current script group.
pub fn compute_sighash_all_message() -> Result<[u8; 32], i8> {
    let tx_hash = load_tx_hash().map_err(|_| ERR_LOAD_TX_HASH)?;

    // First group-input witness: parse, zero the `lock` field (all 66
    // bytes: mode byte + signature), re-serialize. Molecule table field
    // offsets depend only on field byte-lengths, and the replacement is
    // the same length as the original, so the modified witness is
    // byte-for-byte identical to the original except within the lock
    // field itself — exactly mirroring the C reference's in-place zeroing.
    let raw_witness = load_witness(0, Source::GroupInput).map_err(|_| ERR_SIGHASH_WITNESS)?;
    let witness_args =
        packed::WitnessArgs::from_slice(&raw_witness).map_err(|_| ERR_SIGHASH_WITNESS)?;
    let zeroed_lock = Bytes::from(vec![0u8; WITNESS_LOCK_LEN]);
    let modified = witness_args
        .as_builder()
        .lock(Some(zeroed_lock).pack())
        .build();
    let modified_bytes = modified.as_slice();

    let mut hasher = new_blake2b();
    hasher.update(&tx_hash);
    hasher.update(&(modified_bytes.len() as u64).to_le_bytes());
    hasher.update(modified_bytes);

    // Remaining group-input witnesses (same lock script, later inputs),
    // unmodified.
    let mut i = 1usize;
    loop {
        match load_witness(i, Source::GroupInput) {
            Ok(w) => {
                hasher.update(&(w.len() as u64).to_le_bytes());
                hasher.update(&w);
                i += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(ERR_SIGHASH_WITNESS),
        }
    }

    // Witnesses beyond the total input count, unmodified.
    let inputs_len = calculate_inputs_len()?;
    let mut i = inputs_len;
    loop {
        match load_witness(i, Source::Input) {
            Ok(w) => {
                hasher.update(&(w.len() as u64).to_le_bytes());
                hasher.update(&w);
                i += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(ERR_SIGHASH_WITNESS),
        }
    }

    let mut message = [0u8; 32];
    hasher.finalize(&mut message);
    Ok(message)
}

/// Recovers the signer's implied default-lock script hash from a message
/// and a 65-byte recoverable signature (64-byte compact r||s + 1-byte
/// recovery id, same convention as the standard secp256k1 lock).
pub fn recover_lock_hash(message: &[u8; 32], signature: &[u8; 65]) -> Result<[u8; 32], i8> {
    let sig = Signature::try_from(&signature[0..64]).map_err(|_| ERR_SECP_PARSE_SIGNATURE)?;
    let recid = RecoveryId::from_byte(signature[64]).ok_or(ERR_SECP_PARSE_SIGNATURE)?;
    let verifying_key = VerifyingKey::recover_from_prehash(message, &sig, recid)
        .map_err(|_| ERR_SECP_RECOVER_PUBKEY)?;

    // SEC1-compressed (33 bytes) — CKB's own pubkey serialization convention.
    let compressed = verifying_key.to_sec1_point(true);
    let compressed_bytes = compressed.as_bytes();

    let mut pubkey_hash = [0u8; 32];
    let mut pubkey_hasher = new_blake2b();
    pubkey_hasher.update(compressed_bytes);
    pubkey_hasher.finalize(&mut pubkey_hash);
    let blake160 = &pubkey_hash[0..20];

    let script = packed::Script::new_builder()
        .code_hash(SECP256K1_BLAKE160_SIGHASH_ALL_CODE_HASH.pack())
        .hash_type(packed::Byte::new(SCRIPT_HASH_TYPE_TYPE))
        .args(Bytes::copy_from_slice(blake160).pack())
        .build();

    let mut lock_hash = [0u8; 32];
    let mut script_hasher = new_blake2b();
    script_hasher.update(script.as_slice());
    script_hasher.finalize(&mut lock_hash);
    Ok(lock_hash)
}

/// Verifies that `signature` over the current transaction's sighash_all
/// message recovers to a signer whose implied default-lock script hash
/// equals `expected_lock_hash`. Used identically by both the OWNER path
/// (step 6, unconditional) and the RECIPIENT path (step 7 additionally
/// gates on the since-eligibility check).
pub fn verify_signature_matches_lock_hash(
    signature: &[u8; 65],
    expected_lock_hash: &[u8; 32],
) -> Result<bool, i8> {
    let message = compute_sighash_all_message()?;
    let recovered = recover_lock_hash(&message, signature)?;
    Ok(&recovered == expected_lock_hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    /// Independently verified against Python:
    /// `hashlib.blake2b(b"hello tranfr", digest_size=32,
    ///  person=b"ckb-default-hash").hexdigest()`
    /// == d78e3e9f3671efb720ae9be50200a8124b62021be7e395646e7f744f4dfc6ab6
    #[test]
    fn ckb_blake2b_matches_independent_python_reference() {
        let mut hasher = new_blake2b();
        hasher.update(b"hello tranfr");
        let mut out = [0u8; 32];
        hasher.finalize(&mut out);
        assert_eq!(
            hex(&out),
            "d78e3e9f3671efb720ae9be50200a8124b62021be7e395646e7f744f4dfc6ab6"
        );
    }

    fn hex(bytes: &[u8]) -> alloc::string::String {
        use core::fmt::Write;
        let mut s = alloc::string::String::new();
        for b in bytes {
            write!(s, "{:02x}", b).unwrap();
        }
        s
    }

    /// End-to-end recovery pipeline test (no real transaction/witness
    /// syscalls involved — those are exercised in step 9's ckb-testtool
    /// adversarial suite). This isolates and verifies:
    ///   sign(prehash) -> recover_from_prehash -> compressed pubkey ->
    ///   blake160 -> implied Script -> script hash
    /// round-trips to the *same* lock hash a real owner/recipient's
    /// standard secp256k1_blake160_sighash_all wallet lock would have,
    /// derived independently from the same private key here.
    #[test]
    fn recover_lock_hash_matches_signer_for_a_real_signature() {
        let signing_key = SigningKey::from_bytes(&[7u8; 32].into()).expect("valid scalar");
        let message = [0x42u8; 32]; // stand-in prehash; real one is sighash_all's output.

        let (sig, recid) = signing_key.sign_prehash_recoverable(&message);
        let mut sig_bytes = [0u8; 65];
        sig_bytes[0..64].copy_from_slice(&sig.to_bytes());
        sig_bytes[64] = recid.to_byte();

        let recovered = recover_lock_hash(&message, &sig_bytes).expect("recovery succeeds");

        // Independently derive the *expected* lock hash straight from the
        // signing key's own public key, without going through signature
        // recovery, so this test can't pass merely by being internally
        // self-consistent with a bug shared between both paths.
        let verifying_key = signing_key.verifying_key();
        let compressed = verifying_key.to_sec1_point(true);
        let mut pubkey_hash = [0u8; 32];
        let mut h1 = new_blake2b();
        h1.update(compressed.as_bytes());
        h1.finalize(&mut pubkey_hash);

        let script = packed::Script::new_builder()
            .code_hash(SECP256K1_BLAKE160_SIGHASH_ALL_CODE_HASH.pack())
            .hash_type(packed::Byte::new(SCRIPT_HASH_TYPE_TYPE))
            .args(Bytes::copy_from_slice(&pubkey_hash[0..20]).pack())
            .build();
        let mut expected_lock_hash = [0u8; 32];
        let mut h2 = new_blake2b();
        h2.update(script.as_slice());
        h2.finalize(&mut expected_lock_hash);

        assert_eq!(recovered, expected_lock_hash);
    }

    #[test]
    fn recover_lock_hash_rejects_wrong_signature() {
        let signing_key_a = SigningKey::from_bytes(&[7u8; 32].into()).expect("valid scalar");
        let signing_key_b = SigningKey::from_bytes(&[9u8; 32].into()).expect("valid scalar");
        let message = [0x42u8; 32];

        let (sig_a, recid_a) = signing_key_a.sign_prehash_recoverable(&message);
        let mut sig_bytes = [0u8; 65];
        sig_bytes[0..64].copy_from_slice(&sig_a.to_bytes());
        sig_bytes[64] = recid_a.to_byte();

        let recovered_from_a = recover_lock_hash(&message, &sig_bytes).unwrap();

        let verifying_key_b = signing_key_b.verifying_key();
        let compressed_b = verifying_key_b.to_sec1_point(true);
        let mut pubkey_hash_b = [0u8; 32];
        let mut h = new_blake2b();
        h.update(compressed_b.as_bytes());
        h.finalize(&mut pubkey_hash_b);
        let script_b = packed::Script::new_builder()
            .code_hash(SECP256K1_BLAKE160_SIGHASH_ALL_CODE_HASH.pack())
            .hash_type(packed::Byte::new(SCRIPT_HASH_TYPE_TYPE))
            .args(Bytes::copy_from_slice(&pubkey_hash_b[0..20]).pack())
            .build();
        let mut lock_hash_b = [0u8; 32];
        let mut h2 = new_blake2b();
        h2.update(script_b.as_slice());
        h2.finalize(&mut lock_hash_b);

        assert_ne!(recovered_from_a, lock_hash_b);
    }
}
