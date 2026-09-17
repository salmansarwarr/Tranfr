//! Reference port of CKB's own `since` comparison logic, for Tranfr's
//! recipient-path deadline gate (see `/docs/spec.md` §5).
//!
//! This is not a reimplementation from memory. Every constant and the
//! comparison algorithm below is copied verbatim (translated C -> Rust,
//! logic unchanged) from two files in `nervosnetwork/ckb-system-scripts`:
//!
//! - `epoch_number_with_fraction_cmp` <- `c/utils.h`, fetched from the
//!   `master` branch (no specific commit pin available for this file;
//!   the function is pure bit-arithmetic and has had no reason to change).
//! - The flag-matching / dispatch logic in `since_value_satisfied` <-
//!   the body of `check_since` in `c/common.h`, fetched at commit
//!   `63c63e9c96887395fc6990908bcba95476d8aad1` (the commit referenced by
//!   the Omnilock RFC's own citation of this helper).
//!
//! `#![no_std]` outside tests: this is meant to be dropped into the
//! Tranfr lock script crate (`ckb-std`, RISC-V, no std) as-is.

#![cfg_attr(not(test), no_std)]

/// Number of bits in the low part of a `since` value that hold the
/// metric-specific payload; the high 8 bits are flags.
const SINCE_VALUE_BITS: u32 = 56;
/// Mask for the low 56 bits of a `since` value.
const SINCE_VALUE_MASK: u64 = 0x00ff_ffff_ffff_ffff;
/// Flags byte for "absolute + epoch-with-fraction" (relative bit = 0,
/// metric bits = 0b01 at bit positions 5-6 of the flags byte).
const SINCE_EPOCH_FRACTION_FLAG: u8 = 0b0010_0000;

// --- epoch-with-fraction bit packing (within the low 56 bits) ---
const NUMBER_OFFSET: u32 = 0;
const NUMBER_BITS: u32 = 24;
const NUMBER_MASK: u64 = (1u64 << NUMBER_BITS) - 1;
const INDEX_OFFSET: u32 = NUMBER_BITS;
const INDEX_BITS: u32 = 16;
const INDEX_MASK: u64 = (1u64 << INDEX_BITS) - 1;
const LENGTH_OFFSET: u32 = NUMBER_BITS + INDEX_BITS;
const LENGTH_MASK: u64 = (1u64 << 16) - 1;

/// Port of `epoch_number_with_fraction_cmp` from `c/utils.h`.
///
/// `a` and `b` are the low-56-bit *value* portions of two `since` fields
/// already known to use the epoch-with-fraction metric (callers must
/// strip the flags byte and check the metric before calling this).
///
/// Returns `-1` if `a < b`, `0` if `a == b`, `1` if `a > b`, comparing
/// `(epoch, index/length)` lexicographically with cross-multiplication
/// so no floating point or division is used (mirrors the C source
/// exactly, including using `<`/`>` only, never dividing index by length).
pub fn epoch_number_with_fraction_cmp(a: u64, b: u64) -> i8 {
    let a_epoch = (a >> NUMBER_OFFSET) & NUMBER_MASK;
    let a_index = (a >> INDEX_OFFSET) & INDEX_MASK;
    let a_len = (a >> LENGTH_OFFSET) & LENGTH_MASK;

    let b_epoch = (b >> NUMBER_OFFSET) & NUMBER_MASK;
    let b_index = (b >> INDEX_OFFSET) & INDEX_MASK;
    let b_len = (b >> LENGTH_OFFSET) & LENGTH_MASK;

    if a_epoch < b_epoch {
        -1
    } else if a_epoch > b_epoch {
        1
    } else {
        // same epoch: compare a_index/a_len <=> b_index/b_len via cross
        // multiplication. Max operand width: 16 bits * 16 bits = 32 bits,
        // so this never overflows u64.
        let a_block = a_index * b_len;
        let b_block = b_index * a_len;
        if a_block < b_block {
            -1
        } else if a_block > b_block {
            1
        } else {
            0
        }
    }
}

/// Port of the per-input body of `check_since` from `c/common.h`:
/// an input's `since` satisfies a required `since` iff their flag bytes
/// match exactly, and (for the epoch-fraction metric) the input's value
/// is `>=` the required value per `epoch_number_with_fraction_cmp`, or
/// (for every other metric) the input's raw 56-bit value is `>=` the
/// required raw value.
///
/// This is the general, faithful port. Tranfr's actual gate additionally
/// pins both sides to the epoch-fraction metric specifically — see
/// `recipient_path_eligible` below, which is Tranfr-specific policy
/// layered on top of this ported primitive, not part of the port itself.
pub fn since_value_satisfied(input_since: u64, required_since: u64) -> bool {
    let input_flags = (input_since >> SINCE_VALUE_BITS) as u8;
    let required_flags = (required_since >> SINCE_VALUE_BITS) as u8;
    if input_flags != required_flags {
        return false;
    }

    let input_value = input_since & SINCE_VALUE_MASK;
    let required_value = required_since & SINCE_VALUE_MASK;

    if input_flags == SINCE_EPOCH_FRACTION_FLAG {
        epoch_number_with_fraction_cmp(input_value, required_value) >= 0
    } else {
        input_value >= required_value
    }
}

/// Normalizes the low-56-bit epoch-with-fraction value portion of a
/// `since` value so that `index == 0 && length == 0` reads as `index=0,
/// length=1` (RFC 0017's stated degenerate case, "the exact start of the
/// epoch"), leaving every other `(epoch, index, length)` untouched.
///
/// This normalization is deliberately *not* inside
/// `epoch_number_with_fraction_cmp` above, because that function is a
/// verbatim port of `c/utils.h` and is kept byte-for-byte faithful to the
/// verified source for auditability. The raw ported function does NOT
/// perform this normalization itself: when the *first* operand has
/// `length == 0`, its cross-multiplication term collapses to zero
/// regardless of the second operand's fraction, which makes a raw
/// `(epoch, 0, 0)` compare as *equal* to every fraction in that same
/// epoch — not just to `(epoch, 0, 1)` as RFC 0017's prose implies. This
/// was caught by `recipient_path_rejects_degenerate_zero_length_early_claim`
/// below via `cargo test`, not assumed. Whether real CKB consensus ever
/// actually produces an unnormalized `(0,0)` on a live input is unverified
/// either way, so Tranfr normalizes defensively at this layer rather than
/// trusting that assumption in either direction.
fn normalize_epoch_fraction_value(value: u64) -> u64 {
    let index = (value >> INDEX_OFFSET) & INDEX_MASK;
    let length = (value >> LENGTH_OFFSET) & LENGTH_MASK;
    if index == 0 && length == 0 {
        value | (1u64 << LENGTH_OFFSET)
    } else {
        value
    }
}

/// Tranfr's recipient-path deadline gate (`/docs/spec.md` §5).
///
/// Unlike the general `since_value_satisfied` above (which only requires
/// the two flag bytes to *match*, whatever they are), Tranfr requires
/// both `input_since` and `deadline_since` to specifically be
/// absolute + epoch-with-fraction. A relative flag or any other metric
/// on either side is rejected outright rather than falling back to a
/// different comparison, per the spec's explicit non-fallback rule.
///
/// Both sides are passed through `normalize_epoch_fraction_value` first,
/// closing the degenerate-zero-length gap described on that function.
pub fn recipient_path_eligible(input_since: u64, deadline_since: u64) -> bool {
    let input_flags = (input_since >> SINCE_VALUE_BITS) as u8;
    let deadline_flags = (deadline_since >> SINCE_VALUE_BITS) as u8;

    if input_flags != SINCE_EPOCH_FRACTION_FLAG || deadline_flags != SINCE_EPOCH_FRACTION_FLAG {
        return false;
    }

    let normalized_input =
        (input_since & !SINCE_VALUE_MASK) | normalize_epoch_fraction_value(input_since & SINCE_VALUE_MASK);
    let normalized_deadline = (deadline_since & !SINCE_VALUE_MASK)
        | normalize_epoch_fraction_value(deadline_since & SINCE_VALUE_MASK);

    since_value_satisfied(normalized_input, normalized_deadline)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pack (flags_byte, epoch, index, length) into a `since`-shaped u64,
    /// mirroring the real bit layout, for test readability.
    fn pack(flags: u8, epoch: u64, index: u64, length: u64) -> u64 {
        ((flags as u64) << SINCE_VALUE_BITS)
            | ((length & LENGTH_MASK) << LENGTH_OFFSET)
            | ((index & INDEX_MASK) << INDEX_OFFSET)
            | ((epoch & NUMBER_MASK) << NUMBER_OFFSET)
    }

    const EPOCH_FRACTION: u8 = SINCE_EPOCH_FRACTION_FLAG; // 0x20: absolute, epoch metric
    const RELATIVE_EPOCH_FRACTION: u8 = 0b1010_0000; // 0xA0: relative bit set, epoch metric
    const ABSOLUTE_BLOCK_NUMBER: u8 = 0b0000_0000; // 0x00: absolute, block-number metric

    #[test]
    fn epoch_cmp_by_epoch_number_alone() {
        let a = pack(0, 10, 3, 4) & SINCE_VALUE_MASK;
        let b = pack(0, 11, 0, 1) & SINCE_VALUE_MASK;
        assert_eq!(epoch_number_with_fraction_cmp(a, b), -1);
        assert_eq!(epoch_number_with_fraction_cmp(b, a), 1);
    }

    #[test]
    fn epoch_cmp_same_epoch_different_denominators_equal_ratio() {
        // 1/4 == 2/8 within the same epoch -> equal, despite different L.
        let a = pack(0, 10, 1, 4) & SINCE_VALUE_MASK;
        let b = pack(0, 10, 2, 8) & SINCE_VALUE_MASK;
        assert_eq!(epoch_number_with_fraction_cmp(a, b), 0);
    }

    #[test]
    fn epoch_cmp_same_epoch_different_denominators_unequal_ratio() {
        // 3/4 > 2/8 (0.75 > 0.25) within the same epoch.
        let a = pack(0, 10, 3, 4) & SINCE_VALUE_MASK;
        let b = pack(0, 10, 2, 8) & SINCE_VALUE_MASK;
        assert_eq!(epoch_number_with_fraction_cmp(a, b), 1);
        assert_eq!(epoch_number_with_fraction_cmp(b, a), -1);
    }

    #[test]
    fn epoch_cmp_raw_port_does_not_normalize_zero_over_zero_by_itself() {
        // Verified quirk of the verbatim c/utils.h port, confirmed by
        // running this test (initial expectations here were wrong until
        // `cargo test` disproved them): when the FIRST operand has
        // length == 0, its cross-multiplication term is always zero
        // regardless of the second operand, so (epoch,0,0) compares as
        // EQUAL to every fraction in that epoch, not just to (epoch,0,1).
        // This is why `recipient_path_eligible` normalizes before
        // comparing instead of relying on this raw function alone —
        // see `recipient_path_rejects_degenerate_zero_length_early_claim`.
        let zero_over_zero = pack(0, 10, 0, 0) & SINCE_VALUE_MASK;
        let zero_over_one = pack(0, 10, 0, 1) & SINCE_VALUE_MASK;
        let near_end_of_epoch = pack(0, 10, 999, 1000) & SINCE_VALUE_MASK;
        assert_eq!(
            epoch_number_with_fraction_cmp(zero_over_zero, zero_over_one),
            0
        );
        // This is the surprising part: NOT -1 as RFC 0017's "start of
        // epoch" framing would suggest, but 0 (treated as equal/satisfied).
        assert_eq!(
            epoch_number_with_fraction_cmp(zero_over_zero, near_end_of_epoch),
            0
        );
    }

    #[test]
    fn since_value_satisfied_requires_matching_flags() {
        let required = pack(EPOCH_FRACTION, 100, 0, 1);
        let input_different_metric = pack(ABSOLUTE_BLOCK_NUMBER, 100, 0, 1);
        assert!(!since_value_satisfied(input_different_metric, required));
    }

    #[test]
    fn since_value_satisfied_epoch_fraction_boundary_inclusive() {
        let required = pack(EPOCH_FRACTION, 100, 1, 2);
        let exactly_equal = pack(EPOCH_FRACTION, 100, 1, 2);
        let one_tick_before = pack(EPOCH_FRACTION, 100, 0, 2);
        let one_epoch_after = pack(EPOCH_FRACTION, 101, 0, 1);
        assert!(since_value_satisfied(exactly_equal, required));
        assert!(!since_value_satisfied(one_tick_before, required));
        assert!(since_value_satisfied(one_epoch_after, required));
    }

    #[test]
    fn since_value_satisfied_non_fraction_metric_uses_plain_integer_compare() {
        let required = pack(ABSOLUTE_BLOCK_NUMBER, 1_000_000, 0, 0);
        let earlier = pack(ABSOLUTE_BLOCK_NUMBER, 999_999, 0, 0);
        let later = pack(ABSOLUTE_BLOCK_NUMBER, 1_000_001, 0, 0);
        assert!(!since_value_satisfied(earlier, required));
        assert!(since_value_satisfied(later, required));
    }

    #[test]
    fn recipient_path_rejects_relative_flag_even_if_numerically_far_enough() {
        let deadline = pack(EPOCH_FRACTION, 100, 0, 1);
        // A relative since claiming epoch 1_000_000 must still be rejected:
        // it's measured from this input's own commitment block, not real
        // time, and must never be accepted as a substitute for absolute.
        let huge_relative = pack(RELATIVE_EPOCH_FRACTION, 1_000_000, 0, 1);
        assert!(!recipient_path_eligible(huge_relative, deadline));
    }

    #[test]
    fn recipient_path_rejects_wrong_metric_on_either_side() {
        let deadline_block_number = pack(ABSOLUTE_BLOCK_NUMBER, 500, 0, 0);
        let input_epoch_fraction = pack(EPOCH_FRACTION, 500, 0, 1);
        assert!(!recipient_path_eligible(
            input_epoch_fraction,
            deadline_block_number
        ));
    }

    #[test]
    fn recipient_path_rejects_degenerate_zero_length_early_claim() {
        // Deadline set near the very end of epoch 540 (i.e. the owner's
        // window has almost, but not quite, elapsed).
        let deadline = pack(EPOCH_FRACTION, 540, 999, 1000);
        // A recipient who noticed the raw-port quirk above tries to claim
        // by submitting since=(epoch 540, index=0, length=0) — the same
        // epoch, but really the very *start* of it, nowhere near the true
        // deadline fraction.
        let degenerate_early_attempt = pack(EPOCH_FRACTION, 540, 0, 0);

        // Without normalization this would incorrectly succeed (proven
        // directly against the raw port, not asserted from prose):
        assert_eq!(
            since_value_satisfied(degenerate_early_attempt, deadline),
            true,
            "sanity check: the raw port alone is indeed fooled by (0,0)"
        );

        // The Tranfr-level gate must still reject it.
        assert!(!recipient_path_eligible(degenerate_early_attempt, deadline));

        // And a genuinely-normalized (epoch 540, index=0, length=1) input
        // must correctly be rejected as EARLY as well, since 0/1 < 999/1000.
        let honest_start_of_epoch = pack(EPOCH_FRACTION, 540, 0, 1);
        assert!(!recipient_path_eligible(honest_start_of_epoch, deadline));

        // While a fraction genuinely past the deadline still succeeds
        // (start of the next epoch — since index must be strictly less
        // than length, 999/1000 is the last representable fraction
        // within epoch 540 itself).
        let honest_late_fraction = pack(EPOCH_FRACTION, 541, 0, 1);
        assert!(recipient_path_eligible(honest_late_fraction, deadline));
    }

    #[test]
    fn recipient_path_accepts_valid_absolute_epoch_fraction_past_deadline() {
        let deadline = pack(EPOCH_FRACTION, 540, 0, 1); // e.g. ~90 days out
        let just_past = pack(EPOCH_FRACTION, 541, 0, 1);
        let well_before = pack(EPOCH_FRACTION, 1, 0, 1);
        assert!(recipient_path_eligible(just_past, deadline));
        assert!(!recipient_path_eligible(well_before, deadline));
    }
}
