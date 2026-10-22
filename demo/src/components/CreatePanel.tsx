import { useEffect, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { DEFAULT_DURATION_EPOCHS } from "../../../sdk/src/index.js";
import { KeyIdentity, client, errorMessage, tranfr, shortHex } from "../chain";

// A Tranfr cell occupies 113 CKB; renewals pay their fee out of the cell, so leave headroom.
const MIN_CAPACITY_CKB = 120;

interface CreatePanelProps {
  owner?: KeyIdentity;
  recipient?: KeyIdentity;
  onCreated: (txHash: ccc.Hex) => void;
  onLog: (message: string, txHash?: string) => void;
}

export function CreatePanel({ owner, recipient, onCreated, onLog }: CreatePanelProps) {
  const { open, disconnect, wallet } = ccc.useCcc();
  const signer = ccc.useSigner();
  const [walletAddress, setWalletAddress] = useState<string>();
  const [walletBalance, setWalletBalance] = useState<bigint>();
  const [capacity, setCapacity] = useState("200");
  const [duration, setDuration] = useState(DEFAULT_DURATION_EPOCHS.toString());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = setTimeout(() => setCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  useEffect(() => {
    let cancelled = false;
    setWalletAddress(undefined);
    setWalletBalance(undefined);
    if (!signer) return;
    (async () => {
      const [address, balance] = await Promise.all([signer.getRecommendedAddress(), signer.getBalance()]);
      if (!cancelled) {
        setWalletAddress(address);
        setWalletBalance(balance);
      }
    })().catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [signer, busy]);

  const capacityNumber = Number(capacity);
  const durationNumber = Number(duration);
  const inputError =
    !Number.isFinite(capacityNumber) || capacityNumber < MIN_CAPACITY_CKB
      ? `Capacity must be at least ${MIN_CAPACITY_CKB} CKB.`
      : !Number.isInteger(durationNumber) || durationNumber < 1
        ? "Duration must be a whole number of epochs, at least 1."
        : undefined;
  const missing = !owner ? "an owner key" : !recipient ? "a recipient key" : !signer ? "a connected wallet" : undefined;

  async function create() {
    if (!signer || !owner || !recipient || inputError) return;
    setBusy(true);
    setError(undefined);
    try {
      const tx = await tranfr.createTranfr({
        ownerLock: owner.script,
        recipientLock: recipient.script,
        capacity: ccc.fixedPointFrom(capacity),
        durationEpochs: BigInt(durationNumber),
      });
      await tx.completeInputsByCapacity(signer);
      await tx.completeFeeBy(signer);
      const txHash = await signer.sendTransaction(tx);
      onLog("Create submitted, waiting for it to be committed…", txHash);
      await client.waitTransaction(txHash, 0, 180_000);
      onLog("Tranfr cell created.", txHash);
      onCreated(txHash);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>Create a Tranfr cell</h3>
      <p className="muted">
        A CCC wallet pays for the new cell. The owner and recipient are the keys above: wallet connectors can't sign as
        Tranfr owner or recipient, because the lock only accepts plain secp256k1 signatures.
      </p>

      <div className="row">
        {wallet ? (
          <>
            <span className="badge">{wallet.name}</span>
            <span className="mono" title={walletAddress}>
              {walletAddress ? shortHex(walletAddress, 10) : "…"}
            </span>
            {walletAddress && (
              <button type="button" className="secondary" onClick={() => copyAddress(walletAddress)}>
                {copyState === "copied" ? "Copied" : "Copy address"}
              </button>
            )}
            {walletBalance !== undefined && <span>{ccc.fixedPointToString(walletBalance)} CKB</span>}
            <button type="button" className="secondary" onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <button type="button" onClick={open}>
            Connect wallet
          </button>
        )}
      </div>
      {wallet && walletAddress && copyState === "failed" && (
        <p className="muted">
          Couldn&rsquo;t copy automatically. Select the address and copy it:{" "}
          <span className="mono wrap selectable">{walletAddress}</span>
        </p>
      )}

      <div className="grid-2">
        <label>
          Capacity (CKB)
          <input type="number" min={MIN_CAPACITY_CKB} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </label>
        <label>
          Recovery delay (epochs)
          <input type="number" min={1} step={1} value={duration} onChange={(e) => setDuration(e.target.value)} />
          <span className="hint">
            540 ≈ 90 days. Use 1 (≈ 4 hours) to try the recipient claim on testnet.{" "}
            <button type="button" className="link" onClick={() => setDuration("1")}>
              Use 1
            </button>
          </span>
        </label>
      </div>

      {inputError && <p className="error">{inputError}</p>}
      {missing && <p className="muted">Needs {missing} first.</p>}
      {error && <p className="error">{error}</p>}

      <button type="button" onClick={create} disabled={busy || !!inputError || !!missing}>
        {busy ? "Creating…" : "Create Tranfr cell"}
      </button>
    </section>
  );
}
