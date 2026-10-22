# Tranfr — Security Model (v1)

This document explains what Tranfr protects against, what it relies on, why the lock is designed the way it is, and where its limits are. The byte-level rules are in `docs/spec.md`; this document cites its sections rather than restating them.

**Tranfr has not been audited.** It is a proof of concept deployed on testnet only. Don't use it with real funds.

## 1. What Tranfr protects against

Tranfr addresses **owner inactivity**: lost keys, incapacity, or death. The owner keeps full control while active. If the owner doesn't renew before a deadline, a single pre-chosen recipient can claim the funds.

It does **not** protect against theft of the owner's key. The owner path is unconditional (§4.1), so anyone holding the owner key controls the cell immediately, before or after the deadline. Tranfr is a recovery mechanism, not a vault or a delay on spending.

## 2. Trust assumptions

### 2.1 Script upgrade authority (most important)

The testnet deployment uses Type ID (`hash_type = type`, `docs/spec.md` §8). Tranfr cells reference the script by the code cell's type hash, not by the hash of its code. The code cell is locked by the deployer's key (`scripts/deploy.ts`), so **whoever holds the deployer key can replace the binary for every existing Tranfr cell**, including with one that lets anyone spend them.

For a testnet proof of concept this is deliberate: it allows fixes without migrating cells. A mainnet deployment must remove this power, by one of:

- deploying with `hash_type = data1` (cells pin the exact binary, so it can never change), or
- moving the Type ID code cell to an unspendable lock after a final release, or
- putting it under a published multisig or governance process, with that trust stated plainly to users.

Until then, users of a Type ID deployment are trusting the deployer completely.

### 2.2 CKB consensus

Tranfr relies on CKB consensus to:
- run the lock script on every spend of a Tranfr cell;
- reject a transaction unless the including block's epoch is at or past each input's absolute `since` (RFC 0017). This is what turns the recipient's self-declared `since` into a real lower bound on time (`docs/spec.md` §5).

### 2.3 Cryptography

secp256k1 signatures (verified with RustCrypto's `k256`) and `blake2b256` with CKB's personalization, the same primitives as CKB's default lock.

## 3. Roles and key compromise

| Event | Effect | Mitigation |
|---|---|---|
| Owner key lost | Owner can't renew or reclaim. The recipient can claim once the deadline passes. | This is the intended recovery case. |
| Owner key stolen | Attacker controls the cell immediately and can reclaim it, or renew it with themselves as recipient. | None within Tranfr (§1). Treat the owner key like any wallet key. |
| Recipient key lost | Recipient can never claim. Funds stay under owner control. | Owner renews with a new recipient (`renewTranfr`). |
| Recipient key stolen | Attacker can claim after the deadline, unless the owner acts first. | Owner renews with a new recipient before the deadline. |
| Deployer key stolen | Attacker can replace the script for all cells (§2.1). | Make the deployment immutable before mainnet. |
| Owner and recipient are the same key | Owner mode works as usual. Recipient mode is still time-gated, so it grants nothing extra. | Covered by the adversarial tests. |

## 4. Design decisions

### 4.1 Why the owner path is unconditional

CKB's `since` field can only express a **lower bound** ("not before X"). There is no native way for an input to say "only valid *before* the deadline." An earlier Tranfr design (described in the old README) tried to enforce "the owner may only act before the deadline." That needed a multi-step `BEGIN_OWNER_OP` / `PENDING_OWNER_OP` state machine and header dependencies, so that an owner transaction signed before the deadline but broadcast after it couldn't sneak through.

v1 drops the requirement instead of engineering around it. The owner can always act, so there is no "before the deadline" condition to race against, and no upper-bound check to get wrong. The recipient path needs only a lower bound, which is exactly what `since` enforces, and it is checked against the chain at inclusion time, not at signing time.

The consequence is deliberate: after the deadline, both owner and recipient can spend (§6.1). An owner who is still active can always keep or recover their funds. Recovery is for owners who don't act.

### 4.2 Why the recipient path rejects relative and other-metric `since`

The gate (`docs/spec.md` §5) accepts only an input `since` that is **absolute** and **epoch-with-fraction**, matching the deadline's own encoding. Everything else is rejected outright, never compared by another rule:

- **Different metrics measure different things.** A block number, a timestamp, and a packed epoch fraction are not comparable quantities; comparing their raw values compares nothing meaningful. Even where an accidental magnitude relationship might make a particular comparison harmless, the script must not depend on that.
- **A relative `since` is anchored to the input cell's commitment block**, not to a fixed point, so it doesn't name a point in time comparable with an absolute deadline. (A relative value at least as large as the deadline's would in practice only ever be stricter, but rejecting it keeps the rule simple and the reasoning local.)
- **A malformed `deadline_since`** (wrong flags) also fails the gate, so such a cell can never be claimed by the recipient. The owner path still works, so funds are not stuck.

### 4.3 The mode byte is not signed

The signing message zero-fills the whole 66-byte witness lock field, mode byte included (`docs/spec.md` §3.1), mirroring the standard sighash_all construction. Flipping the mode byte therefore doesn't invalidate a signature. It is still safe, because each mode checks the recovered key against a different stored hash:

- A recipient's signature relabelled as OWNER fails `owner_lock_hash` (error 5).
- An owner's signature relabelled as RECIPIENT fails `recipient_lock_hash` (error 6). If owner and recipient are the same key, it passes the signature check but is then time-gated, which gives the owner nothing they didn't already have.

Both cases are in the adversarial suite (`tests/src/tests.rs`).

### 4.4 Exact boundary semantics

- A claim is valid when the input's `since` is **greater than or equal to** the deadline: equality passes.
- Fractions are compared by value, so `(E, 1, 2)` equals `(E, 500, 1000)`.
- `(E, 0, 0)` means the start of epoch `E` and is normalized to `(E, 0, 1)` on both sides. Without that, a raw `(E, 0, 0)` would compare equal to every point in epoch `E` and allow a claim up to a full epoch early. This was found by testing, not visible in the RFC (`reference/README.md`).
- Consensus admits the claim in the first block whose epoch is at or past the input's `since`, so in practice the earliest possible claim is the first block at or after the deadline.

These are covered by the boundary tests: 16-bit-maximum denominators, epoch 0, the maximum 24-bit epoch, near-equal ratios such as 1/3 vs 332/1000 and 334/1000, and degenerate fractions in both positions.

### 4.5 Every input in a group is checked

CKB runs a lock once per group of inputs with identical lock scripts, args included. Two cells with the same owner, recipient and deadline form one group. If only the first input's `since` were checked, a recipient could pair one mature input with a second, unmatured one and claim both early. The script checks every input in the group (`docs/spec.md` §6). This gap was found and fixed during the step 8 audit.

## 5. What the lock does not enforce

The lock answers one question: "is this spend authorized?" Everything else about the transaction is up to whoever builds it.

### 5.1 Owner and recipient must be standard secp256k1 keys

The lock only accepts signatures that resolve to a standard `secp256k1_blake160_sighash_all` lock (`docs/spec.md` §3.1). If a cell's args contain the hash of any other lock (JoyID, MetaMask or another Omnilock, multisig), that role can never sign:
- unusable owner: nobody can renew or reclaim, and the recipient gets the funds after the deadline;
- unusable recipient: the owner must reclaim or renew with a valid recipient;
- both unusable: **the funds are locked permanently.**

The lock itself can't prevent this, because it never runs at creation (§5.3). The SDK does: `createTranfr` and `renewTranfr` reject any owner or recipient lock that isn't `secp256k1_blake160` (that code hash, `hash_type = type`, 20-byte args) before building anything (`assertSecp256k1Lock`). Transactions built without the SDK get no such check.

For the same reason, the CCC wallet connectors (JoyID, MetaMask and other EIP-6963 wallets, UniSat, Xverse, OKX, UTXO Global, Rei, Nostr) can fund the creation of a Tranfr cell but cannot act as owner or recipient. The demo uses in-browser testnet keys for those roles.

### 5.2 Type scripts and cell data

The lock ignores the cell's type script, so keeping a typed asset (for example a UDT) intact is the transaction builder's job. A builder that dropped the type script would, depending on the asset's rules, destroy the asset.

The SDK's `renewTranfr`, `buildOwnerReclaim` and `buildRecoveryClaim` copy the input's type script and data unchanged into their single output, changing only the lock. Running a type script needs its code as a cell dep, and the signature covers the cell deps, so they can't be added after the SDK signs. Callers pass them as `cellDeps`, and the SDK refuses to build a spend of a typed cell without them.

Two limits remain. The SDK moves the whole cell as one unit: there's no splitting a UDT balance or merging cells. And `createTranfr` only creates plain CKB cells; wrapping an existing typed cell in Tranfr has to be built by hand.

### 5.3 Cell creation is unchecked

A lock never runs when a cell is created. Anyone can create a "Tranfr cell" with any owner, recipient and deadline values, including a malformed deadline or a recipient they don't control. A recipient shouldn't assume a cell is claimable just because it names them. Check it with `getTranfrStatus`, which decodes the args and evaluates the deadline with the same comparison the script uses.

### 5.4 Fees and minimum capacity

The SDK pays renew, reclaim and claim fees out of the cell's own capacity, so the owner and recipient keys never need separate funds. A Tranfr cell occupies 113 CKB. The SDK refuses to build a spend whose fee would push the output below its minimum capacity, so cells should hold some headroom above 113 CKB; the demo requires at least 120.

## 6. Timing and liveness

### 6.1 After the deadline it is a race

Once the deadline passes, the owner path and recipient path are both valid, and their transactions spend the same cell. Whichever is committed first wins and the other becomes invalid. An active owner can still renew or reclaim after the deadline, so a recipient's claim is only guaranteed against an owner who stays inactive. This follows from §4.1 and is intended.

### 6.2 Signed but unbroadcast owner transactions

An owner-signed transaction has no expiry: it stays valid for as long as the cell it spends is unspent. Anyone who obtains a signed but unbroadcast renewal can broadcast it later, for example to push the deadline out just as the recipient is about to claim. Owners should broadcast what they sign and not leave signed transactions lying around.

`renewTranfr` computes the new deadline from the chain tip when the transaction is built, not when it is committed. Without an explicit duration it renews for the cell's own period (its deadline minus the epoch of the block that created it), never less than the 90-day default, so a heartbeat can't silently shorten a longer period. A duration that would move the deadline earlier is refused unless the caller sets `allowEarlierDeadline`.

### 6.3 Epoch granularity and drift

Deadlines are in epochs. An epoch is about 4 hours but its wall-clock length varies with difficulty adjustment. The default of 540 epochs was measured at roughly 90 days on both networks (`docs/epoch-length.md`). Any "days remaining" figure is an estimate; the demo derives it from the live epoch rate over the last ~2000 blocks. The on-chain rule is always the epoch comparison, never wall-clock time.

### 6.4 No notification

Nothing reminds the owner to renew or tells the recipient a cell is claimable. The whole security boundary is the lock script, and any reminders are up to the user.

## 7. Non-goals and limitations

- Single recipient only: no social or threshold recovery.
- Owner and recipient must be standard secp256k1 keys (§5.1).
- The SDK creates only plain CKB cells, and moves typed cells whole (§5.2).
- No protection against owner key theft (§1).
- No off-chain notification (§6.4).
- Testnet only, with an upgradeable deployment (§2.1).
- **Not audited.**

## 8. Verification status

**Done:**
- Contract: unit tests plus an adversarial integration suite under `ckb-testtool`, signed with real secp256k1 keys over the real sighash_all message. It covers both paths, the deadline boundaries, `since` metric and relative rejection, multi-input groups, mode-byte swaps, malformed signatures and witnesses, and replay.
- `since` comparison: one shared test suite run against both the Rust and TypeScript ports.
- Codecs: golden vectors checked byte-for-byte in both languages.
- SDK: unit tests against a fake RPC client, including recovery of the signer's public key from each produced signature.

- Testnet: the full lifecycle with SDK-built transactions (`docs/testnet-evidence.md`). That includes a recipient claim the node itself rejected as `Immature` before the deadline, and one after the deadline that paid the recipient.

**Not yet done:**
- A click-through of the demo UI with a real wallet connector. The testnet run used the same SDK calls from a script.
- An independent rebuild confirming the deployed binary hash (`docs/deployment.md` records a single-machine build).
- An independent security audit.
