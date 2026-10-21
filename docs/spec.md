# Tranfr — Protocol Specification (v1)

Status: **final for v1.** Matches the `tranfr-lock` contract in `contracts/tranfr-lock/` and the testnet deployment in `docs/deployment.md`. The byte layouts in §2–§4 are a versioned interface: changing any of them breaks every existing cell and both codecs (Rust and TypeScript), so they change only with a new script version, never in place.

See `docs/security-model.md` for the reasoning behind these rules, the trust assumptions, and the known limitations.

## 1. Mechanism summary

A Tranfr cell is locked by a single custom lock script with two independent unlock paths:

- **OWNER path**: unconditional. The owner can spend the cell at any time, for any reason (reclaim, renew, change recipient). No time check is ever applied to this path.
- **RECIPIENT path**: conditional on a deadline embedded in the cell's own lock args. The recipient can only spend the cell once the transaction's declared `since` value for each of its Tranfr inputs is at or past that deadline (§5).

There is no separate on-chain "heartbeat" transaction type. Renewal is an ordinary owner-path spend that recreates the cell with a new deadline (and optionally a new recipient).

## 2. Lock script args

Fixed-width, 72 bytes total. No molecule schema: the layout is small and fixed, so it is hand-parsed.

| Field | Offset | Size | Description |
|---|---|---|---|
| `owner_lock_hash` | 0 | 32 bytes | `blake2b256` script hash of the owner's `secp256k1_blake160_sighash_all` lock (see §3.1). |
| `recipient_lock_hash` | 32 | 32 bytes | `blake2b256` script hash of the recipient's `secp256k1_blake160_sighash_all` lock. |
| `deadline_since` | 64 | 8 bytes | A CKB `since` value (RFC 0017 encoding, little-endian u64): the earliest point at which the recipient path becomes valid. **Must** be absolute + epoch-with-fraction (§4). Any other encoding makes the recipient path permanently unusable for that cell; the owner path is unaffected. |

Total args length: **72 bytes exactly**. The script rejects any other length (`ERR_ARGS_LEN`, §7).

Full 32-byte script hashes are used rather than the 20-byte blake160 truncation older scripts such as `cheque` use. This is a new script with no legacy constraint, and full hashes avoid the reduced collision margin truncation brings. The cost is 24 extra bytes per cell.

A lock script never runs when its cell is *created*, only when it is spent. Nothing on chain checks these args at creation time: anyone can create a cell with any owner, recipient, or deadline value. Readers must validate a cell's args rather than trust that a cell was built by the SDK.

## 3. Witness layout

The signature and path selector live in `WitnessArgs.lock`, the standard slot for lock-script-specific witness data. Args hold only cell state; per-spend data lives in the witness.

| Field | Offset | Size | Description |
|---|---|---|---|
| `mode` | 0 | 1 byte | `0x00` = OWNER path, `0x01` = RECIPIENT path. Any other value is rejected (`ERR_UNKNOWN_MODE`). |
| `signature` | 1 | 65 bytes | Recoverable secp256k1 signature (`r[32] ‖ s[32] ‖ recovery_id[1]`), the same format as the standard `secp256k1_blake160_sighash_all` lock. |

Total `WitnessArgs.lock` length: **66 bytes exactly** (`ERR_WITNESS_LEN` otherwise). The script reads the witness at the first input of its script group; a missing or malformed `WitnessArgs` is `ERR_LOAD_WITNESS`.

### 3.1 What the signature must prove

The signed message is the `secp256k1_blake160_sighash_all` message, ported verbatim from that script's C source (`contracts/tranfr-lock/src/crypto.rs`):

1. `blake2b256` with CKB's `ckb-default-hash` personalization over:
2. the transaction hash, then
3. the length (u64 LE) and bytes of the script group's first witness, **with its whole 66-byte lock field zero-filled**, then
4. the length and bytes of every other witness in the script group, then
5. the length and bytes of every witness beyond the transaction's input count.

The script recovers the public key from the signature, serializes it compressed (33 bytes, CKB's convention), computes `blake160(pubkey)` (the first 20 bytes of the personalized `blake2b256`), and builds the implied standard lock:

```
Script {
  code_hash: 0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8,  // secp256k1_blake160_sighash_all
  hash_type: type,
  args:      blake160(pubkey),
}
```

It then compares that script's hash against `owner_lock_hash` (mode `0x00`) or `recipient_lock_hash` (mode `0x01`).

Consequence: **owner and recipient must be plain secp256k1 keys with standard CKB default-lock addresses.** A hash of any other lock (JoyID, Omnilock with Ethereum or Bitcoin auth, multisig, etc.) can be stored in the args, but no signature will ever match it, so that role becomes permanently unusable.

Because step 3 zero-fills the whole lock field, the `mode` byte is not covered by the signature. This is safe because each mode checks the recovered key against a different stored hash (`docs/security-model.md` §4.3).

## 4. `deadline_since` encoding (RFC 0017 epoch-with-fraction, absolute)

```
bit 63       : relative flag  — MUST be 0 (absolute)
bits 61–62   : metric type    — MUST be 01 (epoch-with-fraction)
bits 56–60   : reserved       — MUST be 0
bits 0–55    : value
```

So the top byte of a valid `deadline_since` is exactly `0x20`.

Epoch-with-fraction value packing within the low 56 bits:

```
bits 0–23    : epoch number (E)
bits 24–39   : epoch index  (I)
bits 40–55   : epoch length (L)
```

The value denotes the point `E + I/L` epochs. RFC 0017 requires `I < L`, or `I = L = 0`, which means the start of epoch `E` (§5).

**Why epoch-with-fraction rather than timestamp-median:** RFC 0017 doesn't state whether the timestamp metric is in seconds or milliseconds. Epoch-with-fraction is a consensus-native counter with no unit ambiguity between the script and the SDK. The cost is coarser wall-clock precision, since an epoch is about 4 hours and drifts with difficulty adjustment (`docs/epoch-length.md`).

**Why absolute rather than relative:** a relative `since` is measured from the commitment block of the input cell itself, not from a fixed point. Every renewal would silently re-anchor it, so "the recipient may claim from epoch X" could never be stated as a fixed on-chain fact, and status tools would need each cell instance's commitment block to compute it.

## 5. Recipient-path gate and comparison semantics

For every input in the script group (not just the first, §6), the script reads that input's own `since` and requires:

```
eligible = (input_since.relative_flag == 0)                      // else ERR_RELATIVE_SINCE
        && input_since.flags   == 0x20  (absolute, epoch-fraction) // else ERR_SINCE_NOT_ELIGIBLE
        && deadline_since.flags == 0x20                           // else ERR_SINCE_NOT_ELIGIBLE
        && epoch_fraction_gte(normalize(input_since), normalize(deadline_since))
```

where `normalize` maps a degenerate `(I = 0, L = 0)` fraction to `(0, 1)`, and

```
epoch_fraction_gte((E1, I1, L1), (E2, I2, L2)) =
    E1 > E2  ||  (E1 == E2 && I1 * L2 >= I2 * L1)
```

**Boundary semantics:**
- **Equality is eligible.** An input `since` exactly equal to the deadline passes.
- **Equal ratios with different denominators are equal.** `(E, 1, 2)` and `(E, 500, 1000)` compare equal; values are compared by cross-multiplication, never as raw packed integers and never via floating point.
- **Degenerate fractions are normalized on both sides.** Without normalization, the cross-multiplication treats a raw `(E, 0, 0)` as equal to every fraction in epoch `E`, which would let a recipient claim up to a whole epoch early. Normalizing both operands closes this; it was found by testing, not visible from the RFC text (`reference/README.md`).
- **No fallback.** A relative or other-metric `since` is rejected outright, never compared by some other rule.

The `since` value is chosen by whoever builds the transaction, but consensus only admits a transaction into a block whose epoch is at or past every input's absolute `since`. Requiring `since ≥ deadline` therefore means the claim can't be committed before the chain actually reaches the deadline. The check runs against the chain at inclusion time, not at signing time.

The comparison is implemented once in `reference/since-cmp-rs` (Rust, used by the contract) and once in `sdk/src/since-cmp.ts` (TypeScript, used by the SDK). Both are ports of `epoch_number_with_fraction_cmp` and `check_since` from `nervosnetwork/ckb-system-scripts`, with the same test suite.

## 6. Transaction-level behaviour

- **Script groups.** CKB runs a lock script once per group of inputs sharing the same lock script, args included. One witness at the group's first input covers the whole group, as with the standard secp256k1 lock.
- **Every input's `since` is checked.** On the recipient path the script loops over every input in the group (`ERR_LOAD_SINCE` if that syscall fails). Checking only the first input would let a recipient pair a mature input with a second unmatured cell sharing the same lock, and claim it early.
- **Owner path ignores `since`.** Any `since` (none, relative, other metric) is accepted on the owner path, including on a cell whose `deadline_since` is malformed.
- **Outputs are unconstrained.** The lock checks authorization only. It doesn't constrain where outputs go, whether a renewed cell keeps the same owner, or what happens to a type script on the cell. Those are the transaction builder's responsibility (`docs/security-model.md` §5).
- **Replay.** The signature commits to the transaction hash, so it can't be moved to another transaction or another cell.

## 7. Error codes

| Code | Name | Meaning |
|---|---|---|
| 0 | — | Success. |
| 1 | `ERR_UNKNOWN_MODE` | `mode` byte is not `0x00` or `0x01`. |
| 2 | `ERR_ARGS_LEN` | Args are not exactly 72 bytes. |
| 3 | `ERR_WITNESS_LEN` | `WitnessArgs.lock` is not exactly 66 bytes. |
| 4 | `ERR_LOAD_WITNESS` | `WitnessArgs` missing, empty, malformed, or has no lock field. |
| 5 | `ERR_OWNER_SIG` | OWNER mode: recovered key's implied lock hash ≠ `owner_lock_hash`. |
| 6 | `ERR_RECIPIENT_SIG` | RECIPIENT mode: recovered key's implied lock hash ≠ `recipient_lock_hash`. |
| 7 | `ERR_RELATIVE_SINCE` | RECIPIENT mode: an input's `since` has the relative flag set. |
| 8 | `ERR_SINCE_NOT_ELIGIBLE` | RECIPIENT mode: wrong metric, malformed `deadline_since`, or deadline not yet reached. |
| 9 | `ERR_LOAD_SCRIPT` | Could not load the script. |
| 10 | `ERR_LOAD_TX_HASH` | Could not load the transaction hash for the signing message. |
| 11 | `ERR_SIGHASH_WITNESS` | Could not load or parse a witness for the signing message. |
| 12 | `ERR_CALCULATE_INPUTS` | Could not count transaction inputs for the signing message. |
| 13 | `ERR_SECP_PARSE_SIGNATURE` | Signature bytes invalid (bad `r`/`s` or recovery id). |
| 14 | `ERR_SECP_RECOVER_PUBKEY` | Public key recovery failed. |
| 15 | `ERR_LOAD_SINCE` | Could not load an input's `since`. |

The recipient path checks the signature before the `since` gate, so a wrong signer always gets 6, even before the deadline.

## 8. Deployment reference (testnet)

| Field | Value |
|---|---|
| Network | CKB Testnet (Pudge), genesis `0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606` |
| `code_hash` | `0xffc6b1c122037a97c18878f583ab789ea7f6cf3a1febc1e02e4fd9f36c442bfd` (Type ID) |
| `hash_type` | `type` |
| Cell dep | `0x0d0eb86d886c4c0f0981489498c68aba8bc914a946bbbf11ceec8c13ce442c08` index `0`, `dep_type = code` |
| Binary data hash | `0x24a5f576896042fa4583b9536189edfd21731c3d82f29ba28395a8145d77da3d` |

Because the deployment uses Type ID, cells reference the script by its type hash, not its code. Whoever controls the code cell can replace the binary for every Tranfr cell. This is acceptable for a testnet proof of concept and must not carry over to mainnet as-is (`docs/security-model.md` §2.1). Details and reproduction steps: `docs/deployment.md`.

## 9. Non-goals for v1

- No multi-recipient or threshold recovery: `recipient_lock_hash` is a single value, not a list or Merkle root.
- No signer types other than `secp256k1_blake160_sighash_all` for owner or recipient (§3.1).
- No on-chain distinction between "heartbeat" and "recipient change": both are owner-path spends producing a new cell. The distinction exists only in the SDK (`renewTranfr`).
- No restriction on type scripts on Tranfr cells: the lock ignores the type field. The SDK preserves a cell's type script and data when spending it, but only creates plain CKB cells (`docs/security-model.md` §5.2).
