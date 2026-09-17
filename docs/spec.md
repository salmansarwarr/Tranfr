# Tranfr — On-Chain Data Layout (v1)

Status: frozen for implementation (step 1 of `implementation-plan.md`). Any change here invalidates the byte-layout assumptions baked into the Rust script and the TypeScript SDK codecs — treat it as a versioned interface, not a draft.

## 1. Mechanism summary

A Tranfr cell is locked by a single custom lock script with two independent unlock paths:

- **OWNER path** — unconditional. The owner can spend the cell at any time, for any reason (reclaim, renew, change recipient). No time check is ever applied to this path.
- **RECIPIENT path** — conditional on a deadline embedded in the cell's own lock args. The recipient can only spend the cell once the transaction's declared `since` value for that input is at or past the embedded deadline.

There is no separate on-chain "heartbeat" transaction type. Renewal is just an ordinary owner-path spend that recreates the cell with a new deadline (and optionally a new recipient) — see `renewTranfr` in the SDK plan.

## 2. Lock script args

Fixed-width, 72 bytes total. No molecule schema — the layout is small and fixed, so it is hand-parsed.

| Field | Offset | Size | Description |
|---|---|---|---|
| `owner_lock_hash` | 0 | 32 bytes | `blake2b256` hash of the owner's full lock script (script struct, not just pubkey), per CKB's standard script-hash convention. |
| `recipient_lock_hash` | 32 | 32 bytes | `blake2b256` hash of the recovery recipient's full lock script, same convention. |
| `deadline_since` | 64 | 8 bytes | A CKB `since` value (RFC 0017 encoding, little-endian u64) representing the earliest point at which the recipient path becomes valid. **Must** be encoded as absolute + epoch-with-fraction (see §4) — any other flag/metric combination in this field is invalid and MUST cause the script to reject every recipient-path spend of the cell. |

Total args length: **72 bytes exactly**. The script rejects any cell whose args are not exactly 72 bytes.

Rationale for using full 32-byte script hashes (not the 20-byte truncated blake160 convention `cheque` uses): this is a new, independent script with no legacy compatibility constraint, and full hashes avoid the second-preimage/collision-margin tradeoffs that motivated blake160 truncation in older CKB scripts (bandwidth was the original justification for truncation; 24 extra bytes per cell here is not a meaningful cost).

## 3. Witness layout

The signature and path selector live in `WitnessArgs.lock` (the standard CKB witness slot for lock-script-specific data), not in the args. This keeps args pure cell state and keeps the witness — which varies per spend — separate from it.

| Field | Offset | Size | Description |
|---|---|---|---|
| `mode` | 0 | 1 byte | `0x00` = OWNER path, `0x01` = RECIPIENT path. Any other value MUST cause immediate rejection. |
| `signature` | 1 | 65 bytes | Recoverable secp256k1 signature (r, s, recovery_id), same format and same sighash-construction convention as the standard `secp256k1_blake160_sighash_all` lock, computed over the transaction hash with this witness's lock field zero-filled. |

Total `WitnessArgs.lock` length: **66 bytes exactly**.

The recovered pubkey hash is compared against `owner_lock_hash` when `mode = 0x00`, or `recipient_lock_hash` when `mode = 0x01`. Note this compares against the **lock-script hash** stored in args (§2), not a bare pubkey hash — so the recovered signature's implied secp256k1 default-lock script (`{code_hash: secp256k1_blake160_sighash_all, args: recovered_pubkey_hash}`) must be re-hashed and compared against the stored 32-byte value, mirroring how any script validates "this signature authorizes this specific lock."

## 4. `deadline_since` encoding (RFC 0017 epoch-with-fraction, absolute)

`deadline_since` is a 64-bit value with this bit layout, per RFC 0017:

```
bit 63       : relative flag        — MUST be 0 (absolute) for a valid Tranfr cell
bits 61–62   : metric type          — MUST be 01 (epoch-with-fraction)
bits 56–60   : reserved             — MUST be 0
bits 0–55    : value (see below)
```

Epoch-with-fraction value packing (all little-endian within the 56-bit value field):

```
bits 0–23    : epoch number   (E)
bits 24–39   : epoch index    (I)
bits 40–55   : epoch length   (L)
```

Constraint inherited from RFC 0017: `I < L`, or both zero (which the reference implementation treats as `I=0, L=1`).

**Why epoch-with-fraction and not timestamp-median:** RFC 0017 does not state the unit (seconds vs. milliseconds) for the timestamp metric in its own text, and confirming it requires reading `ckb-std`/node source rather than the spec. Epoch-with-fraction has no such ambiguity — it's a plain, consensus-native counter — so it is used here to remove an entire class of unit-mismatch bugs between the Rust script and the TypeScript SDK. If a future revision needs wall-clock precision tighter than epoch granularity (~4h), timestamp-median can be added as a second supported metric, but that is out of scope for v1.

**Why absolute and not relative:** a relative `since` is measured from the referenced input cell's own commitment block, not from a fixed real-world point. Two consequences make relative unsuitable here: (a) every time the owner renews the cell (spends it and creates a new one), a relative deadline would silently re-anchor to the new commitment block regardless of what the SDK intended, making "90 days from setup" impossible to state as a fixed on-chain fact; (b) it would make `getTranfrStatus`/`isRecoveryEligible` unable to compute a stable deadline without also tracking the exact commitment block of the current cell instance. Absolute avoids both.

## 5. Comparison semantics (recipient path gate)

The script must NOT compare `deadline_since` and the input's live `since` field as raw 64-bit integers — `(E, I, L)` triples with different `L` denominators are not numerically comparable by naive integer comparison of the packed value. The gate condition is:

```
eligible = (input_since.relative_flag == 0)
        && (input_since.metric == EPOCH_WITH_FRACTION)
        && epoch_fraction_gte(input_since.value, deadline_since.value)
```

where `epoch_fraction_gte((E1,I1,L1), (E2,I2,L2))` is true iff:

```
E1 > E2
|| (E1 == E2 && I1 * L2 >= I2 * L1)
```

(cross-multiplication to compare `I1/L1 >= I2/L2` without floating point or division). This exact algorithm has been ported and independently tested in both languages — see `/reference/since-cmp-rs` (Rust, `cargo test`, 11/11 passing) and `/reference/since-cmp-ts` (TypeScript, `node --test`, 11/11 passing) — rather than reimplemented separately from memory in the script and the SDK. Both import from that shared, verified module rather than each carrying their own copy.

If `input_since.relative_flag != 0` or `input_since.metric != EPOCH_WITH_FRACTION`, the recipient path MUST reject outright — it must not fall back to any other comparison, since accepting a relative or differently-metric'd `since` would let a recipient construct a spend that consensus does not actually anchor to real elapsed time.

**Confirmed by testing, not assumed:** the verbatim-ported comparison function does *not* itself normalize the degenerate `(index=0, length=0)` fraction to "start of epoch" as RFC 0017's prose implies — when the first operand has `length == 0`, its cross-multiplication term is always zero regardless of the second operand, so a raw, unnormalized `(epoch, 0, 0)` compares as equal to *every* fraction within that epoch, not just to `(epoch, 0, 1)`. Left unhandled, this would let a recipient claim early by crafting a degenerate `since` value. Both ports therefore normalize `(0,0) -> (0,1)` on **both** `input_since` and `deadline_since` immediately before comparing (see `normalize_epoch_fraction_value` / `normalizeEpochFractionValue`), rather than depending on whichever fraction happens to be spelled out. See `/reference/README.md` for the full writeup and reproduction.

## 6. Non-goals for this layout (v1)

- No multi-recipient / threshold recovery — `recipient_lock_hash` is a single 32-byte value, not a list or Merkle root.
- No on-chain distinction between "heartbeat" and "recipient change" — both are just an owner-path spend producing a new output with new args; the SDK layer (`renewTranfr`) is where that distinction exists, not the script.
- No support for ordinary type-script assets beyond capacity in this layout description — if Tranfr later wraps SUDT or other type scripts, the `Type` field of the cell carries that independently of this lock's args and is unaffected by this spec.

## 7. Zero-index/zero-length normalization — resolved

This was an open item pending verification; it is now closed. The `(index=0, length=0)` normalization is **not** something the verified upstream comparison code performs on its own (see §5's confirmed-by-testing note) — Tranfr's own gate (`recipient_path_eligible` / `recipientPathEligible`) performs it explicitly instead, on both sides of the comparison, before delegating to the ported algorithm. Remaining item for step 5/7: when the Rust module is embedded into the actual lock script crate, confirm `ckb-std`'s `load_input_since` returns the raw `since` u64 needed here rather than an already-decoded/reinterpreted type that would need different handling.
