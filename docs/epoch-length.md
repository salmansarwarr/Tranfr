# Epoch length — measured, not assumed (step 3 of `implementation-plan.md`)

Tranfr's deadline is expressed on-chain as an absolute epoch-with-fraction `since` value (`docs/spec.md` §4), not a wall-clock timestamp. "90 days" is therefore always an *epoch-count approximation* of a calendar duration, not something the chain can guarantee to the second — the SDK's job is to pick a good epoch constant for that approximation, not to promise exact calendar precision. This document derives that constant from live chain data instead of assuming CKB's nominal "~4 hour epoch" figure.

## Method

For both networks: query `get_current_epoch`, then batch-fetch the previous 40 epochs via `get_epoch_by_number`, then batch-fetch the block header at each epoch's `start_number` via `get_header_by_number`. Epoch duration is `timestamp[i] - timestamp[i-1]` between consecutive epoch-start headers — real elapsed wall-clock time, not the `length` field (which counts blocks, not seconds, and is itself dynamically adjusted by consensus to keep wall-clock epoch time near target as hashrate/block-time varies).

Queried on 2026-09-22 against the public endpoints from `docs.nervos.org`.

## Results

**Testnet** (`https://testnet.ckb.dev/`), epochs 13829–13869 (40 transitions, ~6.7 days of real chain time):
- Epoch length (blocks): constant at 1800 for this entire window.
- Per-epoch duration: min 13668.4s, max 15330.1s (~3.80h–4.26h; block-time noise around the 8s target).
- **Average: 14402.3s = 4.0006 hours.**
- Measured epochs/day: 5.999. Measured epochs for 90 days: **539.91 → 540.**

**Mainnet** (`https://mainnet.ckb.dev/`), epochs 14934–14974 (40 transitions):
- Epoch length (blocks): **not constant** — ranged from 1112 to 1800 blocks across the window (real hashrate variation actively drives CKB's epoch-length adjustment here, unlike the testnet window sampled).
- Per-epoch duration: min 12974.4s, max 15863.1s.
- **Average: 14426.9s = 4.0075 hours.**
- Measured epochs/day: 5.9888. Measured epochs for 90 days: **538.99 → 539.**

Despite mainnet's block-count-per-epoch swinging by over 60% within the sample, wall-clock epoch duration stayed within 0.2% of the testnet figure — exactly what CKB's epoch-length adjustment is designed to do (hold wall-clock epoch time near target by varying the block count, rather than holding block count fixed and letting wall-clock time drift).

## Conclusion

The nominal assumption ("~4h/epoch → 6/day → 540 for 90 days") is confirmed against live data on both networks, not merely plausible-sounding: measured values are 540 (testnet) and 539 (mainnet) from real 40-epoch samples, i.e. within one epoch (~4 hours, ~0.2%) of each other and of the round-number estimate.

**Recommendation for the SDK (steps 16/17):** use **540 epochs** as the default `durationEpochs` for both `createTranfr` and `renewTranfr`, exposed as an epoch count, not a "days" value the SDK silently converts — since the conversion is inherently approximate (epoch wall-clock length drifts with network conditions; the two 40-epoch samples above differ by ~0.2% from each other), the API should not imply false calendar precision. `isRecoveryEligible`/`getTranfrStatus` (steps 14/15) should compute "days remaining" for display purposes only, from the *current* live epoch length via `get_current_epoch`, never from the hardcoded 540 constant — display estimates should track present chain conditions, while the on-chain deadline itself is fixed in epochs at creation time and cannot drift once set.

This 540-epoch figure is a point-in-time measurement (2026-09-22), not a network constant guaranteed to hold forever — if epoch wall-clock length is ever revisited (e.g. before mainnet deployment much later), re-run the query in this file's Method section rather than reusing this number indefinitely.
