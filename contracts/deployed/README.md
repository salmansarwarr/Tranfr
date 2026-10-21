# Deployed binaries (vendored for tests)

Byte-for-byte copies of the scripts the composed design uses, read from their
deployment cells on CKB testnet (`ckb_testnet`) with `get_transaction`. The
composition tests in `tests/` run these exact binaries under `ckb-testtool`,
and a test checks their hashes against the values below.

| File | Script | Testnet cell (tx_hash, index) | code_hash / hash_type | blake2b data hash |
|---|---|---|---|---|
| `time-lock` | Time Lock ([ckb-proxy-locks](https://github.com/ckb-devrel/ckb-proxy-locks/tree/main/contracts/time-lock)) | `0x1b4ffcad55ecd36ffb2715b6816b83da73851f1a24fe594f263c4f34dad90792`, `0x1` | `0x6fac4b2e89360a1e692efcddcb3a28656d8446549fb83da6d896db8b714f4451` / `data1` | same as code_hash |
| `cheque-lock` | Cheque lock ([RFC 0039](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0039-cheque/0039-cheque.md)) | `0x1b16769dc508c8349803fe65558f49aa8cf04ca495fbead42513e69e46608b6c`, `0x0` | `0x60d5f39efce409c587cb9ea359cefdead650ca128f0bd9cb3855348f98c70d5b` / `type` | `0xbe734faa9ead3cfeef2efba92de6b6bdb5b0cadb6cd36c896081e8cab18e79b9` |

Code hashes and cell deps were taken from
[docs.nervos.org/docs/ecosystem-scripts/time-lock](https://docs.nervos.org/docs/ecosystem-scripts/time-lock)
and RFC 0039, then checked against the chain:

- Time Lock's data hash equals its `data1` code hash.
- The Cheque cell's type-script hash equals its `type` code hash.
- The Cheque testnet cell dep is the dep group
  `0x7f96858be0a9d584b4a9ea190e0420835156a6010a5fde15ffcdc9d9c721ccab` index `0x0`.
  It contains the Cheque binary above and the genesis `secp256k1_data` cell
  (`0x8f8c79eb6671709633fe6a46de93c0fedc9c1b8a6527a18d3983879542635c9f`, index `0x3`).
