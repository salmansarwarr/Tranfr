# Reference: `since` comparison (step 2 of `docs/implementation-plan.md`)

Two independently-tested ports of the same verified algorithm, kept in sync by construction (the TS port is a direct translation of the already-tested Rust, not a separate re-derivation):

- `since-cmp-rs/` — Rust, `#![no_std]`-clean, meant to be dropped into the Tranfr lock script crate as-is (step 5/7).
- `since-cmp-ts/` — TypeScript, meant to back `isRecoveryEligible` and `getTranfrStatus` in the SDK (step 13/14).

## Provenance

- `epochNumberWithFractionCmp` / `epoch_number_with_fraction_cmp` — verbatim translation of `epoch_number_with_fraction_cmp` in [`nervosnetwork/ckb-system-scripts` `c/utils.h`](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/utils.h) (master branch; no specific commit pin available for this file).
- `sinceValueSatisfied` / `since_value_satisfied` — translation of the per-input comparison body of `check_since` in `c/common.h`, fetched at commit `63c63e9c96887395fc6990908bcba95476d8aad1` (the commit the Omnilock RFC itself cites for this helper).
- `recipientPathEligible` / `recipient_path_eligible` — Tranfr-specific policy (not part of the upstream port): pins both sides to absolute + epoch-with-fraction per `/docs/spec.md` §5, and normalizes the degenerate `(index=0, length=0)` case before comparing (see finding below).

## Finding from testing (not assumed from the RFC text)

RFC 0017 states that `(index=0, length=0)` should read as "the exact start of the epoch," equivalent to `(index=0, length=1)`. The actual verified C comparison function does **not** perform that normalization: when the first operand has `length == 0`, its cross-multiplication term collapses to zero regardless of the second operand's fraction, so an un-normalized `(epoch, 0, 0)` compares as **equal to every fraction in that epoch** — not just to `(epoch, 0, 1)`.

Concretely: if a deadline is set to `(epoch 540, index 999, length 1000)` — nearly the end of epoch 540 — a raw, unnormalized comparison against a claim using `since = (epoch 540, index 0, length 0)` reports "satisfied," even though real elapsed time is nowhere near the deadline. This was caught by `cargo test` failing on an initial (wrong) assumption, not spotted by inspection — see `recipient_path_rejects_degenerate_zero_length_early_claim` / `recipientPathEligible rejects degenerate zero-length early claim` in the test files for the reproduction, and `normalize_epoch_fraction_value` / `normalizeEpochFractionValue` for the fix.

Whether real CKB consensus ever actually produces an unnormalized `(0,0)` `since` value on a live input is **unverified either way** — both ports normalize defensively regardless, rather than depending on that assumption.

## Running the tests

```sh
# Rust
cd since-cmp-rs && cargo test

# TypeScript (global ts-node is used here; NODE_PATH points node at the
# global install so `-r ts-node/register` resolves without a local
# package.json/node_modules — revisit once step 12 scaffolds the real SDK
# package, which should carry its own devDependency instead of relying on
# whatever happens to be installed globally on a given machine).
cd since-cmp-ts && NODE_PATH=$(npm root -g) node -r ts-node/register --test since_cmp.test.ts
```

Both suites currently pass 11/11, covering the same cases in both languages: epoch-only ordering, equal-ratio/unequal-ratio same-epoch comparisons, the degenerate zero-length quirk (raw and normalized), flag-mismatch rejection, non-fraction-metric plain comparison, relative-flag rejection, and boundary-inclusive (`>=`) acceptance.
