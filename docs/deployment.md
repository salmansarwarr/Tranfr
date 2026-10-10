# Deployment

## Status: DEPLOYED (Testnet)

The contract binary is deployed on CKB Testnet (Pudge) using a native Type ID type script. The deployment transaction has been confirmed on-chain.

## Deployment Details

| Field | Value |
|---|---|
| Network / Genesis | `ckb_testnet` (`0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606`) |
| Transaction Hash (`tx_hash`) | `0x0d0eb86d886c4c0f0981489498c68aba8bc914a946bbbf11ceec8c13ce442c08` |
| Output Index | `0` |
| Cell Capacity | 108,726 CKB (`10872600000000` Shannons) |
| `code_hash` (Type ID) | `0xffc6b1c122037a97c18878f583ab789ea7f6cf3a1febc1e02e4fd9f36c442bfd` |
| `hash_type` | `type` |
| Type ID Script Args | `0xb7dde334fbb3c3d0eb9bda670ad406922c09a8fa000b51f7b140078ff115d3dc` |
| Binary Data Hash (`data_hash`) | `0x24a5f576896042fa4583b9536189edfd21731c3d82f29ba28395a8145d77da3d` |
| Block Number | 22,699,494 (`0x15a5de6`) |
| Block Hash | `0x938a882707c2df43a872879d08af578e3d1aeee6e064b8b0ef8a51436cb89309` |
| Explorer Link | [View on CKB Testnet Explorer](https://pudge.explorer.nervos.org/transaction/0x0d0eb86d886c4c0f0981489498c68aba8bc914a946bbbf11ceec8c13ce442c08) |

## Cell Dep Reference for Transactions

To use `tranfr-lock` in CKB transactions:

```typescript
const TRANFR_CELL_DEP = {
  outPoint: {
    txHash: "0x0d0eb86d886c4c0f0981489498c68aba8bc914a946bbbf11ceec8c13ce442c08",
    index: 0,
  },
  depType: "code",
};

const TRANFR_SCRIPT_CONFIG = {
  codeHash: "0xffc6b1c122037a97c18878f583ab789ea7f6cf3a1febc1e02e4fd9f36c442bfd",
  hashType: "type",
};
```

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

## Deployment Script (Step 10 / Step 11)

A reproducible deployment script powered by `@ckb-ccc/core` is located at `scripts/deploy.ts`. It deploys the compiled binary to CKB testnet using native Type ID (`hash_type = type`) so the deployed contract reference remains upgradeable.

### Prerequisites

- Build artifact: `build/release/tranfr-lock` (108,600 bytes)
- Node.js & dependencies (`npm install`)
- A funded CKB testnet private key with at least ~108,726 CKB (to cover cell capacity + tx fee). Faucet available at: [https://faucet.nervos.org/](https://faucet.nervos.org/).

### Running the Deployment

```bash
# 1. Validate environment, hashes, and network RPC without broadcasting
npm run deploy

# 2. Dry-run with an account to verify balance and derived address
npx tsx scripts/deploy.ts --key 0x<YOUR_PRIVATE_KEY> --dry-run

# 3. Broadcast deployment transaction to testnet and update this doc
CKB_TESTNET_PRIVATE_KEY=0x<YOUR_PRIVATE_KEY> npm run deploy
```

## Step 10 & 11 Status: Complete

1. Official testnet identity confirmed: `ckb_testnet`, genesis `0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606`.
2. Binary deployed with Type ID script to preserve upgradeability.
3. Broadcasted and confirmed in block `22,699,494` (`0x15a5de6`).
4. Type ID `code_hash`: `0xffc6b1c122037a97c18878f583ab789ea7f6cf3a1febc1e02e4fd9f36c442bfd`.


