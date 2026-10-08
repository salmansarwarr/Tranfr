# Deployment

## Status: NOT YET DEPLOYED

The binary is built and hashed locally. The testnet transaction has not been
sent: it needs a funded testnet key and an explicit go-ahead to broadcast.

## Build artifact (local, unverified by a second machine)

| Field | Value |
|---|---|
| Binary | `build/release/tranfr-lock` (`make build CONTRACT=tranfr-lock`) |
| Size | 108600 bytes |
| sha256 | `866da13128580f22d9bcf713ffd1f2fb6286bf512e2870744ccdb9d7288feb0e` |
| CKB data hash (blake2b-256, `ckb-default-hash`) | `0x24a5f576896042fa4583b9536189edfd21731c3d82f29ba28395a8145d77da3d` |

The `make build` run ends with a `tranfr-lock-sim` package error from the
template's simulator step. The binary is already copied by then; the error is
unrelated to the artifact.

## To do for step 10

1. Confirm the current official testnet identity (genesis hash) via RPC.
2. Deploy the binary in a cell with a `type` script, so `hash_type = type`
   survives upgrades (`ckb-cli deploy` or `offckb deploy`; neither is installed here).
3. Record network, tx_hash, index, type-script hash, and `code_hash` below.

| Field | Value |
|---|---|
| Network / genesis | _pending_ |
| tx_hash | _pending_ |
| index | _pending_ |
| code_hash (type id) | _pending_ |
| hash_type | `type` |
