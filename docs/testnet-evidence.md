# Testnet evidence: full lifecycle

The complete Tranfr lifecycle, run on CKB testnet (`ckb_testnet`, Pudge) against
the deployed lock (`code_hash 0xffc6b1c122037a97c18878f583ab789ea7f6cf3a1febc1e02e4fd9f36c442bfd`,
`hash_type = type`; see `docs/deployment.md`) on 2026-10-21 and 2026-10-22.

**How it was run.** `scripts/testnet-lifecycle.ts` drives the SDK (`TranfrClient`)
with the same calls the demo makes: `createTranfr` funded by a wallet signer,
`renewTranfr`, `buildOwnerReclaim`, `buildRecoveryClaim`, `getTranfrStatus`.
It was run from a script rather than by clicking through the demo UI, because no
browser was available in the environment used. All three keys were freshly
generated for this run:

| Role | Address |
|---|---|
| Funder (stands in for the demo's connected wallet) | `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqf2zlf4pzu757f0dezcz05u2ewufk0qp6g0ckzg3` |
| Owner | `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqf4789kln9vk5vvwrnw755jd080cvk4pwc8ke447` |
| Recipient | `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdr8uruh0v587trmsemae0n9nmtkgl8hdcsns3l0` |

Three 200 CKB cells were created, each with a 1-epoch (~4 h) deadline so the
recovery path could be exercised within a day: **A** (extended, then claimed by
the recipient), **B** (reclaimed by the owner after the deadline) and **C**
(reclaimed by the owner before the deadline).

## Transactions

Epochs are shown as `number+index/length`.

| # | Step | Transaction | Block | Chain epoch | Result |
|---|---|---|---|---|---|
| 1 | Create A | [`0x52665afe…2b76`](https://pudge.explorer.nervos.org/transaction/0x52665afe42d50b3f60a169116e39492a98de9e187cb282e44cd1d500d0202b76) | 22,817,768 | 14047+1431/1800 | 200 CKB, deadline 14048+119/150 |
| 2 | Create B | [`0xfec4e0b8…da14`](https://pudge.explorer.nervos.org/transaction/0xfec4e0b8ac6823621f47b28e129a96c2c2b7e2f6b97c5441728241d882d7da14) | 22,817,771 | 14047+1434/1800 | 200 CKB, deadline 14048+159/200 |
| 3 | Create C | [`0x0d1407f5…3986`](https://pudge.explorer.nervos.org/transaction/0x0d1407f5cbf0502ca59cf894a0ef36c7320d9dfb2e900c4948a1a9d1c7653986) | 22,817,774 | 14047+1437/1800 | 200 CKB, deadline 14048+239/300 |
| 4 | **Extend A** (owner renew) | [`0x682aaf70…f0b7`](https://pudge.explorer.nervos.org/transaction/0x682aaf70e6dbac305ec4459237018680518791ca2d4dd4dc28c7a823aa59f0b7) | 22,817,778 | 14047+1441/1800 | Deadline moved later: 14048+119/150 → 14048+719/900 |
| 5 | **Owner reclaims C before its deadline** | [`0x1ae2f886…3386`](https://pudge.explorer.nervos.org/transaction/0x1ae2f8868db552fb03d54a6d3b2c8c3a9d28a02736cef71f98c2b64536b23386) | 22,817,790 | 14047+1453/1800 | Paid to the owner, OWNER-mode witness |
| 6 | Early recipient claim on A, via the SDK | — (not built) | — | ~14047.8 | SDK refused: `Recovery is not yet eligible: the embedded deadline has not passed` |
| 7 | **Early recipient claim on A, sent to the node with the SDK check bypassed** | — (rejected) | — | ~14047.8 | Node rejected: `TransactionFailedToVerify … Immature(Inputs[0]): the transaction is immature because of the since requirement` |
| 8 | **Recipient claims A after its deadline** | [`0x9d500e22…c7a9`](https://pudge.explorer.nervos.org/transaction/0x9d500e226fd041f6f4b3cd1c98546367ce1aad78804a6711d7740a7f7c8ac7a9) | 22,820,455 | 14049+518/1800 | **199.99999236 CKB paid to the recipient**, RECIPIENT-mode witness |
| 9 | **Owner reclaims B after its deadline** | [`0xb2ad5775…a238`](https://pudge.explorer.nervos.org/transaction/0xb2ad5775320e9d647cc39559990bcae5be781538f250d2ff0934bebb3c78a238) | 22,820,458 | 14049+521/1800 | **199.99999644 CKB paid to the owner**, OWNER-mode witness |
| 10 | Status of A and B after spending | — | — | — | `getTranfrStatus` reports `No live Tranfr cell … (not found or already spent)` for both |

## What this shows

- **The owner can always take the funds.** C was reclaimed before its deadline
  (row 5) and B after it (row 9). Both use the OWNER path with no `since` at all.
- **The recipient can't claim early, even bypassing the SDK.** The SDK refuses
  locally (row 6). A claim built anyway, with `since` set to the deadline, is
  rejected by the testnet node itself as `Immature` (row 7). Consensus won't
  admit an input whose `since` is ahead of the chain.
- **The recipient can claim once the deadline passes, and receives the CKB.**
  Row 8 pays the protected capacity, minus a 0.00000764 CKB fee, to the
  recipient's own address. This is the property the Time Lock + Cheque
  composition couldn't provide (see `docs/implementation-plan.md`).
- **The boundary is inclusive, and fractions are compared by value.** The claim's
  input `since` is exactly the deadline, `0x20038402cf0036e0` (absolute,
  epoch-with-fraction, `14048+719/900`). The SDK stores the deadline as a
  reduced fraction (`719/900`), while the chain's epoch has length 1800, so both
  the lock's cross-multiplied comparison and consensus accepted equal values
  written in different denominators.
- **Renewing extends the deadline** (row 4), and **status stops reporting spent
  cells** (row 10).

Independent re-check after the run, read from the chain: the owner's address
holds 399.99999288 CKB (B and C returned) and the recipient's 199.99999236 CKB
(A). The original 600 CKB is accounted for except for fees.

## Not covered by this run

- The demo UI itself was not clicked through. The script exercises the same SDK
  calls, but the wallet-connector funding flow (JoyID, MetaMask, …) was stood in
  for by a private-key signer.
- The deadlines were 1 epoch, not the 540-epoch (~90 day) default.
- The claim was included about half an epoch after its deadline (block epoch
  14049+518/1800 vs deadline 14048+719/900), because the run polled for
  eligibility before sending, so this doesn't pin down the earliest possible
  inclusion block.
