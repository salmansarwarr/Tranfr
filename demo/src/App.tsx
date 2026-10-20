import { useCallback, useEffect, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { TRANFR_TESTNET_CONFIG } from "../../sdk/src/index.js";
import {
  ChainClock,
  KeyIdentity,
  errorMessage,
  formatDuration,
  identityOf,
  readChainClock,
  shortHex,
  txUrl,
} from "./chain";
import { loadStored, saveStored } from "./storage";
import { KeyCard } from "./components/KeyCard";
import { CreatePanel } from "./components/CreatePanel";
import { CellCard, TrackedCell } from "./components/CellCard";

const CLOCK_REFRESH_MS = 30_000;

interface LogEntry {
  id: number;
  time: Date;
  message: string;
  txHash?: string;
}

function useIdentity(privateKey: ccc.Hex | undefined): KeyIdentity | undefined {
  const [identity, setIdentity] = useState<KeyIdentity>();
  useEffect(() => {
    let cancelled = false;
    setIdentity(undefined);
    if (privateKey) identityOf(privateKey).then((id) => !cancelled && setIdentity(id));
    return () => {
      cancelled = true;
    };
  }, [privateKey]);
  return identity;
}

export function App() {
  const [ownerKey, setOwnerKey] = useState<ccc.Hex | undefined>(() => loadStored("ownerKey", undefined));
  const [recipientKey, setRecipientKey] = useState<ccc.Hex | undefined>(() => loadStored("recipientKey", undefined));
  const [cells, setCells] = useState<TrackedCell[]>(() => loadStored("cells", []));
  const owner = useIdentity(ownerKey);
  const recipient = useIdentity(recipientKey);

  const [clock, setClock] = useState<ChainClock>();
  const [clockError, setClockError] = useState<string>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loadTxHash, setLoadTxHash] = useState("");
  const [loadIndex, setLoadIndex] = useState("0");

  useEffect(() => saveStored("ownerKey", ownerKey), [ownerKey]);
  useEffect(() => saveStored("recipientKey", recipientKey), [recipientKey]);
  useEffect(() => saveStored("cells", cells), [cells]);

  const refresh = useCallback(() => {
    readChainClock()
      .then((next) => {
        setClock(next);
        setClockError(undefined);
      })
      .catch((err) => setClockError(errorMessage(err)));
    setRefreshToken((token) => token + 1);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, CLOCK_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const addLog = useCallback((message: string, txHash?: string) => {
    setLog((entries) => [{ id: Date.now() + Math.random(), time: new Date(), message, txHash }, ...entries].slice(0, 30));
  }, []);

  function track(cell: TrackedCell) {
    setCells((current) =>
      current.some((c) => c.txHash === cell.txHash && c.index === cell.index) ? current : [cell, ...current],
    );
  }

  function untrack(cell: TrackedCell) {
    setCells((current) => current.filter((c) => !(c.txHash === cell.txHash && c.index === cell.index)));
  }

  function replace(oldCell: TrackedCell, newCell: TrackedCell) {
    setCells((current) =>
      current.map((c) => (c.txHash === oldCell.txHash && c.index === oldCell.index ? newCell : c)),
    );
  }

  const loadIndexNumber = Number(loadIndex);
  const canLoad = /^0x[0-9a-fA-F]{64}$/.test(loadTxHash.trim()) && Number.isInteger(loadIndexNumber) && loadIndexNumber >= 0;

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Tranfr testnet demo</h1>
          <p className="muted">
            The owner keeps full control. The recipient can claim only after the owner has been inactive past the
            deadline.
          </p>
        </div>
        <div className="network">
          <span className="badge">CKB Testnet</span>
          <span className="mono muted" title={TRANFR_TESTNET_CONFIG.codeHash}>
            lock {shortHex(TRANFR_TESTNET_CONFIG.codeHash, 6)}
          </span>
        </div>
      </header>

      <p className="notice">
        Testnet only. Owner and recipient keys are generated and stored unencrypted in this browser&rsquo;s local
        storage. Never use a key that holds real funds.
      </p>

      <div className="chain-line muted">
        {clock ? (
          <>
            Tip epoch {clock.tipEpoch.toFixed(3)} · 1 epoch ≈ {formatDuration(clock.msPerEpoch)}
            {clock.nominal ? " (nominal; live sample unavailable)" : " (live, last 2000 blocks)"}
          </>
        ) : clockError ? (
          <span className="error">Couldn&rsquo;t read the chain: {clockError}</span>
        ) : (
          "Reading chain…"
        )}
      </div>

      <h2>1. Keys</h2>
      <div className="grid-2">
        <KeyCard
          title="Owner key"
          description="Signs renewals and reclaims. Never needs funds: fees come out of the Tranfr cell."
          privateKey={ownerKey}
          identity={owner}
          onChange={setOwnerKey}
        />
        <KeyCard
          title="Recipient key"
          description="Can claim the cell once the deadline passes. Also needs no funds."
          privateKey={recipientKey}
          identity={recipient}
          onChange={setRecipientKey}
        />
      </div>

      <h2>2. Create</h2>
      <CreatePanel
        owner={owner}
        recipient={recipient}
        onLog={addLog}
        onCreated={(txHash) => track({ txHash, index: 0 })}
      />

      <h2>3. Tranfr cells</h2>
      <section className="card">
        <h3>Track an existing cell</h3>
        <div className="row">
          <input
            className="grow mono"
            placeholder="Transaction hash (0x…)"
            value={loadTxHash}
            onChange={(e) => setLoadTxHash(e.target.value)}
          />
          <input
            className="narrow"
            type="number"
            min={0}
            value={loadIndex}
            onChange={(e) => setLoadIndex(e.target.value)}
            aria-label="Output index"
          />
          <button
            type="button"
            disabled={!canLoad}
            onClick={() => {
              track({ txHash: loadTxHash.trim().toLowerCase(), index: loadIndexNumber });
              setLoadTxHash("");
            }}
          >
            Track
          </button>
        </div>
      </section>

      {cells.length === 0 ? (
        <p className="muted">No cells tracked yet. Create one above or paste an existing out point.</p>
      ) : (
        cells.map((cell) => (
          <CellCard
            key={`${cell.txHash}:${cell.index}`}
            cell={cell}
            owner={owner}
            recipient={recipient}
            clock={clock}
            now={now}
            refreshToken={refreshToken}
            onLog={addLog}
            onRenewed={(txHash) => replace(cell, { txHash, index: 0 })}
            onSpent={() => untrack(cell)}
            onRemove={() => untrack(cell)}
          />
        ))
      )}

      <h2>Activity</h2>
      <section className="card">
        {log.length === 0 ? (
          <p className="muted">Transactions you send from this page appear here.</p>
        ) : (
          <ul className="log">
            {log.map((entry) => (
              <li key={entry.id}>
                <span className="muted">{entry.time.toLocaleTimeString()}</span> {entry.message}{" "}
                {entry.txHash && (
                  <a className="mono" href={txUrl(entry.txHash)} target="_blank" rel="noreferrer">
                    {shortHex(entry.txHash)}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
