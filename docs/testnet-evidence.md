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

- This script run didn't use the demo UI or a wallet connector; see the
  click-through below, which does.
- The deadlines were 1 epoch, not the 540-epoch (~90 day) default.
- The claim was included about half an epoch after its deadline (block epoch
  14049+518/1800 vs deadline 14048+719/900), because the run polled for
  eligibility before sending, so this doesn't pin down the earliest possible
  inclusion block.

## Demo click-through (Playwright)

The same lifecycle was then driven through the demo UI itself with Playwright
(`demo/e2e/lifecycle.spec.ts`, run with `npm run e2e` in `demo/`), headless
Chromium, on 2026-10-22. Every click is in the real demo: **Generate key**,
**Connect wallet**, the **Create** form with **Use 1**, **Renew**, **Reclaim**,
**Claim**. Transaction hashes were read from the demo's own Activity panel.

**Wallet.** A real browser wallet can't be driven headless (JoyID needs a
passkey; MetaMask is an extension needing a seed). The spec injects a test
wallet that speaks the same protocol: it announces itself over EIP-6963 and
answers `eth_requestAccounts`, `eth_accounts` and `personal_sign`, the only
calls CCC's EIP-6963 signer makes, with signing done in Node with a fresh key.
The demo's real CCC connector listed it alongside JoyID, MetaMask, OKX and
UniSat, and CCC's real EVM/Omnilock signer paid for the three cells. Funding the
test wallet's address was setup, standing in for the faucet.

| Role | Address |
|---|---|
| Test wallet (Omnilock, EVM auth) | `ckt1qrejnmlar3r452tcg57gvq8patctcgy8acync0hxfnyka35ywafvkqgjdw8hgd60hzzjde9twkg0rjswwwwumhvtqqhtv528` |
| Owner (generated in the UI) | `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqgf7gzj4eacwdsda2nljesrwmyu5zsjdpgxxdde7` |
| Recipient (generated in the UI) | `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqvchaztztdawyp9wfjktgphw2fpujz6rtqgm20um` |

| # | UI action | Transaction | Result |
|---|---|---|---|
| 0 | Fund the test wallet (setup) | [`0x4e34c99f…6379`](https://pudge.explorer.nervos.org/transaction/0x4e34c99fe2b41453153635d56788e5e161352882bb58202d6940a36fbe096379) | 1,000 CKB to the wallet |
| 1 | Create A (Create form, wallet pays) | [`0x2c4e966c…861d`](https://pudge.explorer.nervos.org/transaction/0x2c4e966c92054c92e92a8c01222627c1d34d63fa92fa4bfa522e18540931861d) | 200 CKB, 1-epoch deadline |
| 2 | Create B | [`0x5a78756d…5c3c`](https://pudge.explorer.nervos.org/transaction/0x5a78756d8ea3f9af5b0bab37bd040686fa04c94b60441ff575a0ba9797aa5c3c) | 200 CKB, deadline 14050+323/600 |
| 3 | Create C | [`0x4c257f4b…d797`](https://pudge.explorer.nervos.org/transaction/0x4c257f4bfed168a0ae42163e2b618f6af32070718ecb835e89dea24f67fad797) | 200 CKB |
| 4 | Claim button on A before the deadline | — | **Disabled** (recipient key loaded, not yet claimable) |
| 5 | **Renew** A | [`0x5ae9b24c…d53d`](https://pudge.explorer.nervos.org/transaction/0x5ae9b24c3a8640035094c3cdb017a1e1e9c72a48742f977b6f719d3e47ecd53d) | New deadline 14050+122/225 |
| 6 | **Reclaim** C before its deadline | [`0xc231442c…24dd`](https://pudge.explorer.nervos.org/transaction/0xc231442c4e86754aa4becdb8e03a954142832a15ae265181eefef08f51f524dd) | Paid back to the owner |
| 7 | After the deadlines: A and B show **Recipient can claim**, Claim enabled | — | App's own status, chain epoch 14053+1273/1800 |
| 8 | **Claim** A (recipient) | [`0x23b66b79…79bb`](https://pudge.explorer.nervos.org/transaction/0x23b66b79b27b243ffef2f7e0112aa70fa2da051ba8cdd03f00be8d37f02f79bb) | **199.99999236 CKB to the recipient** (re-checked from the chain by the spec) |
| 9 | **Reclaim** B after its deadline (owner) | [`0xd058f424…c29c`](https://pudge.explorer.nervos.org/transaction/0xd058f424bd5862967f1db22ec8453c954f2a117c7dd46705c254710a6be6c29c) | Paid back to the owner |
| 10 | Spent cells | — | A and B leave the list; C's card shows "No live Tranfr cell … already spent" |

Screenshots (owner/recipient private keys stay masked):

- [Three cells with live countdowns, Claim disabled](testnet-evidence/demo-01-three-cells.png)
- [After the deadlines: Recipient can claim](testnet-evidence/demo-02-claimable.png)
- [After Claim and Reclaim](testnet-evidence/demo-03-done.png)

**Stranded test funds.** A first attempt failed after creating three cells,
because a locator matched the wrong button ("Claim" also matches "Reclaim").
That version of the spec only saved the browser storage, which held the
generated owner and recipient keys, at the end. So those keys were lost, and
these three 200 CKB testnet cells can never be spent:
[`0xbae7f954…00c5`](https://pudge.explorer.nervos.org/transaction/0xbae7f954e91cb5d5ae12022203ff9b296bb2d04bd6fd164d64e740d925f000c5),
[`0xdfd65967…ee8b`](https://pudge.explorer.nervos.org/transaction/0xdfd65967ebaaf0e4b9b25989b416d41ed7364ffb5aadd7b99b3026192309ee8b),
[`0xf194c0cf…0780`](https://pudge.explorer.nervos.org/transaction/0xf194c0cf6ac6974bfb87c7dc23784757e7d5217d4aeb4c843b025325a7aa0780).
The spec now saves storage straight after generating keys and after every step.
That's the same loss a real user of the demo would face if they lost their
browser storage, which is what the demo's "testnet only" warning is about.

Still not covered: a real wallet (JoyID passkey, MetaMask extension). The
connector and CCC's signer are real; the wallet behind them is a test stand-in.
