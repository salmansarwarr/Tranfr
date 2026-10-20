import { useEffect, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { DEFAULT_DURATION_EPOCHS, TranfrStatus } from "../../../sdk/src/index.js";
import {
  ChainClock,
  KeyIdentity,
  client,
  epochToNumber,
  errorMessage,
  estimateEpochTimeMs,
  formatDuration,
  formatEpoch,
  scriptFromAddress,
  shortHex,
  sinceToEpoch,
  tranfr,
  txUrl,
} from "../chain";

export interface TrackedCell {
  txHash: string;
  index: number;
}

interface CellCardProps {
  cell: TrackedCell;
  owner?: KeyIdentity;
  recipient?: KeyIdentity;
  clock?: ChainClock;
  now: number;
  refreshToken: number;
  onRenewed: (newTxHash: ccc.Hex) => void;
  onSpent: () => void;
  onRemove: () => void;
  onLog: (message: string, txHash?: string) => void;
}

export function CellCard(props: CellCardProps) {
  const { cell, owner, recipient, clock, now, refreshToken, onRenewed, onSpent, onRemove, onLog } = props;
  const [status, setStatus] = useState<TranfrStatus>();
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [renewEpochs, setRenewEpochs] = useState(DEFAULT_DURATION_EPOCHS.toString());
  const [newRecipient, setNewRecipient] = useState("");
  const [reclaimTo, setReclaimTo] = useState("");
  const [claimTo, setClaimTo] = useState("");

  useEffect(() => {
    let cancelled = false;
    tranfr
      .getTranfrStatus({ txHash: cell.txHash, index: cell.index })
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
        setLoadError(undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus(undefined);
        setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [cell.txHash, cell.index, refreshToken]);

  async function run(label: string, build: () => Promise<ccc.Transaction>, after: (txHash: ccc.Hex) => void) {
    setBusy(label);
    setActionError(undefined);
    try {
      const tx = await build();
      const txHash = await client.sendTransaction(tx);
      onLog(`${label} submitted, waiting for it to be committed…`, txHash);
      await client.waitTransaction(txHash, 0, 180_000);
      onLog(`${label} committed.`, txHash);
      after(txHash);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(undefined);
    }
  }

  const outPointLabel = `${shortHex(cell.txHash)}:${cell.index}`;

  if (!status) {
    return (
      <section className="card">
        <div className="card-head">
          <h3 className="mono">{outPointLabel}</h3>
          <button type="button" className="secondary" onClick={onRemove}>
            Remove
          </button>
        </div>
        {loadError ? <p className="error">{loadError}</p> : <p className="muted">Loading status…</p>}
      </section>
    );
  }

  const deadlineEpoch = sinceToEpoch(status.deadlineSince);
  const currentEpoch = sinceToEpoch(status.currentEpochSince);
  const isOwner = owner?.lockHash === status.ownerLockHash;
  const isRecipient = recipient?.lockHash === status.recipientLockHash;
  const deadlineMs = clock ? estimateEpochTimeMs(clock, epochToNumber(deadlineEpoch)) : undefined;

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="mono">
          <a href={txUrl(cell.txHash)} target="_blank" rel="noreferrer">
            {outPointLabel}
          </a>
        </h3>
        <span className={status.isClaimable ? "badge warn" : "badge ok"}>
          {status.isClaimable ? "Recipient can claim" : "Owner only"}
        </span>
      </div>

      <div className="countdown">
        {status.isClaimable ? (
          <strong>The recovery deadline has passed.</strong>
        ) : (
          <>
            <strong>{deadlineMs !== undefined ? `≈ ${formatDuration(deadlineMs - now)}` : "…"}</strong>
            <span className="muted">
              {" "}
              until the recipient can claim ({status.epochsRemaining.toString()} epoch
              {status.epochsRemaining === 1n ? "" : "s"} left)
            </span>
          </>
        )}
      </div>

      <dl className="fields">
        <dt>Capacity</dt>
        <dd>{ccc.fixedPointToString(status.cell.cellOutput.capacity)} CKB</dd>
        <dt>Deadline epoch</dt>
        <dd className="mono">{formatEpoch(deadlineEpoch)}</dd>
        <dt>Current epoch</dt>
        <dd className="mono">{formatEpoch(currentEpoch)}</dd>
        <dt>Owner</dt>
        <dd className="mono" title={status.ownerLockHash}>
          {shortHex(status.ownerLockHash)} {isOwner ? <span className="tag">your owner key</span> : null}
        </dd>
        <dt>Recipient</dt>
        <dd className="mono" title={status.recipientLockHash}>
          {shortHex(status.recipientLockHash)} {isRecipient ? <span className="tag">your recipient key</span> : null}
        </dd>
      </dl>

      <div className="actions">
        <div className="action">
          <h4>Owner: renew</h4>
          <p className="muted">Recreates the cell with a fresh deadline. Optionally changes the recipient.</p>
          <label>
            New delay (epochs)
            <input type="number" min={1} step={1} value={renewEpochs} onChange={(e) => setRenewEpochs(e.target.value)} />
          </label>
          <label>
            New recipient address (optional)
            <input value={newRecipient} onChange={(e) => setNewRecipient(e.target.value)} placeholder="ckt1…" />
          </label>
          {recipient && !isRecipient && (
            <button type="button" className="link" onClick={() => setNewRecipient(recipient.address)}>
              Use the loaded recipient key
            </button>
          )}
          <button
            type="button"
            disabled={!isOwner || !!busy || !(Number.isInteger(Number(renewEpochs)) && Number(renewEpochs) >= 1)}
            onClick={() =>
              run(
                "Renew",
                async () =>
                  tranfr.renewTranfr({
                    cell: status.cell,
                    ownerPrivateKey: owner!.privateKey,
                    newDurationEpochs: BigInt(Number(renewEpochs)),
                    newRecipientLock: newRecipient.trim() ? await scriptFromAddress(newRecipient) : undefined,
                  }),
                onRenewed,
              )
            }
          >
            {busy === "Renew" ? "Renewing…" : "Renew"}
          </button>
        </div>

        <div className="action">
          <h4>Owner: reclaim</h4>
          <p className="muted">Spends the cell back out. Works any time, even after the deadline.</p>
          <label>
            Send to address (optional)
            <input value={reclaimTo} onChange={(e) => setReclaimTo(e.target.value)} placeholder="Defaults to the owner key" />
          </label>
          <button
            type="button"
            disabled={!isOwner || !!busy}
            onClick={() =>
              run(
                "Reclaim",
                async () =>
                  tranfr.buildOwnerReclaim({
                    cell: status.cell,
                    ownerPrivateKey: owner!.privateKey,
                    toLock: reclaimTo.trim() ? await scriptFromAddress(reclaimTo) : undefined,
                  }),
                onSpent,
              )
            }
          >
            {busy === "Reclaim" ? "Reclaiming…" : "Reclaim"}
          </button>
        </div>

        <div className="action">
          <h4>Recipient: claim</h4>
          <p className="muted">Only valid once the deadline epoch has been reached.</p>
          <label>
            Send to address (optional)
            <input value={claimTo} onChange={(e) => setClaimTo(e.target.value)} placeholder="Defaults to the recipient key" />
          </label>
          <button
            type="button"
            disabled={!isRecipient || !status.isClaimable || !!busy}
            onClick={() =>
              run(
                "Claim",
                async () =>
                  tranfr.buildRecoveryClaim({
                    cell: status.cell,
                    recipientPrivateKey: recipient!.privateKey,
                    toLock: claimTo.trim() ? await scriptFromAddress(claimTo) : undefined,
                  }),
                onSpent,
              )
            }
          >
            {busy === "Claim" ? "Claiming…" : "Claim"}
          </button>
        </div>
      </div>

      {!isOwner && !isRecipient && (
        <p className="muted">Neither loaded key matches this cell, so you can watch it but not act on it.</p>
      )}
      {actionError && <p className="error">{actionError}</p>}

      <div className="row end">
        <button type="button" className="secondary" onClick={onRemove}>
          Stop tracking
        </button>
      </div>
    </section>
  );
}
