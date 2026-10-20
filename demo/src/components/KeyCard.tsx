import { useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { KeyIdentity, generatePrivateKey, normalizePrivateKey, shortHex } from "../chain";

interface KeyCardProps {
  title: string;
  description: string;
  privateKey?: ccc.Hex;
  identity?: KeyIdentity;
  onChange: (privateKey: ccc.Hex | undefined) => void;
}

export function KeyCard({ title, description, privateKey, identity, onChange }: KeyCardProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string>();
  const [revealed, setRevealed] = useState(false);

  function importKey() {
    const key = normalizePrivateKey(input);
    if (!key) {
      setError("Expected 32 bytes of hex (64 hex characters, optional 0x prefix).");
      return;
    }
    setError(undefined);
    setInput("");
    onChange(key);
  }

  return (
    <section className="card">
      <h3>{title}</h3>
      <p className="muted">{description}</p>

      {privateKey ? (
        <dl className="fields">
          <dt>Address</dt>
          <dd className="mono wrap">{identity?.address ?? "Deriving…"}</dd>
          <dt>Lock hash</dt>
          <dd className="mono" title={identity?.lockHash}>
            {identity ? shortHex(identity.lockHash) : "…"}
          </dd>
          <dt>Private key</dt>
          <dd className="mono wrap">
            {revealed ? privateKey : "•".repeat(24)}{" "}
            <button type="button" className="link" onClick={() => setRevealed(!revealed)}>
              {revealed ? "Hide" : "Reveal"}
            </button>
          </dd>
        </dl>
      ) : (
        <p className="muted">No key loaded.</p>
      )}

      <div className="row">
        <button type="button" onClick={() => onChange(generatePrivateKey())}>
          {privateKey ? "Replace with new key" : "Generate key"}
        </button>
        {privateKey && (
          <button type="button" className="secondary" onClick={() => onChange(undefined)}>
            Forget key
          </button>
        )}
      </div>

      <div className="row">
        <input
          type="password"
          placeholder="Or paste a testnet private key"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          aria-label={`${title} private key`}
        />
        <button type="button" className="secondary" onClick={importKey} disabled={!input.trim()}>
          Import
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
