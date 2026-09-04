# Tranfr

Programmable recovery for CKB self-custody — a lock script that lets an owner
keep full control of their assets while active, and lets a designated
recovery recipient claim them if the owner goes inactive for a defined
period. No custodian, no oracle, no protocol changes.

---

## The problem

A CKB Cell's spending conditions answer to exactly one key. If that key is
lost, destroyed, or its holder becomes unavailable, the funds are
permanently unreachable — the Cell remains valid on-chain, but nobody can
satisfy its lock. Existing options each trade something away:

- **Multisig** — requires multiple parties for every normal operation
- **Custodians** — introduce a trusted intermediary
- **Manual inheritance** — relies on off-chain coordination
- **Application-specific recovery** — isn't reusable elsewhere
- **A plain single-key lock** — has no fallback at all

Tranfr uses CKB's Cell Model and `since` timelock primitive to add a
recovery path without any of the above tradeoffs.

## How it works

A Tranfr commits to an **owner**, a **recovery recipient**, and a fixed
**inactivity period**. While active, the owner can:

- send a **heartbeat** to reset the inactivity timer, or
- issue a **policy update** to change the recovery recipient (which also
  resets the timer)

If neither happens before the deadline, the owner path freezes and the
**recovery recipient** becomes able to claim the funds, provided both their
signature and the expired timelock are satisfied.

### Corrected owner-op state machine

Earlier design iterations used a single-step, caller-selected `header_dep`
to decide whether an owner operation landed before or after the deadline.
Community review identified a race condition: a heartbeat or policy update
**signed** before the deadline but **broadcast** after it could not be
reliably rejected, because `since` only enforces a lower bound on validity,
not an upper one.

Tranfr v1 closes this with a two-phase commit:

```
ACTIVE
  -> owner-signed BEGIN_OWNER_OP
       -> PENDING_OWNER_OP
            -> NORMALIZE -> ACTIVE
            -> RECOVER   -> CLAIMED
```

`BEGIN_OWNER_OP` only commits to the requested operation (heartbeat or
recipient update) — it does not apply it. When `PENDING_OWNER_OP` is later
consumed, the lock script resolves the **actual commitment block** of that
input Cell via `ckb_load_header(..., input_index, CKB_SOURCE_INPUT)`, not an
arbitrary header chosen by the transaction builder:

```
begin_epoch  = epoch of the block that committed PENDING_OWNER_OP
old_deadline = previous_deadline_epoch
timely       = epoch_less(begin_epoch, old_deadline)
```

If `timely`, the operation applies and a new deadline is derived from
`begin_epoch`. If not, the operation has **no effect** — the previous
recovery recipient and deadline remain authoritative, and the pending Cell
remains recoverable so no value can get stuck.

This makes owner authority depend on **when the state transition entered
the canonical chain**, not on when it was signed or which header the owner
chose to reference.

## Known limitations

- **v1 covers heartbeat and recipient-update only.** The same commit-bound
  race condition applies to ordinary spending (a spend signed before the
  deadline but broadcast after it), which requires an analogous
  `BEGIN_SPEND → PENDING_SPEND → SETTLE_SPEND/RECOVER` construction. That
  fix is planned for a future release, not this one.
- **Single recipient only.** Social or threshold multi-party recovery is
  out of scope for v1.
- **No off-chain notification.** The entire security boundary is the lock
  script itself; there is no off-chain component to reason about.
- **Not audited.** This is a proof-of-concept implementation. Do not use
  with real funds without an independent security audit.

## Repository structure

```
/contracts        Lock script (CKB-VM), owner-op and recovery paths
/tests            Adversarial and epoch-boundary test suite
/demo             Minimal testnet UI exercising the full v1 lifecycle
/docs             Protocol spec, security model, threat model, test vectors
```

## Test coverage

The test suite validates, at minimum:

- A pre-signed, withheld heartbeat/policy-update has no effect once the
  deadline passes, regardless of when it was signed
- An arbitrary stale header cannot substitute for the header associated
  with the actual pending input Cell
- Late `NORMALIZE` attempts are rejected; the pending Cell remains
  recoverable
- Replay of the same operation against a later Tranfr state fails
  (state hash / nonce binding)
- Epoch-fraction boundary comparisons match identically between the SDK
  and the lock script
- Recovery cannot execute before the derived effective deadline, and is
  valid once it has passed

See `/docs/test-vectors.md` for the full list.

## Status & roadmap

| Phase | Scope |
|---|---|
| 1 — Protocol validation | State machine, threat model, feasibility of the commit-bound expiry mechanism |
| 2 — Lock script | `BEGIN_OWNER_OP` / `PENDING_OWNER_OP` / `NORMALIZE` / `RECOVER`, full test suite |
| 3 — Testnet demo | Minimal UI: create, heartbeat, recipient update, expiry, recovery |
| 4 (future) | `BEGIN_SPEND` / `PENDING_SPEND` / `SETTLE_SPEND` construction for ordinary spending |
| 5 (future) | SDK, production hardening, external audit |

## References

- [CKB RFC 0022 — Transaction Structure / Header Deps](https://github.com/nervosnetwork/rfcs)
- [CKB RFC 0017 — Transaction Since Precondition](https://github.com/nervosnetwork/rfcs)
- CKB Open Transaction / CoBuild Protocol Overview

## License

MIT (or specify — TBD)

## Acknowledgements

Thanks to community reviewer Tianji for identifying the commit-bound expiry
race condition addressed in this design.
