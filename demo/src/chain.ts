import { ccc } from "@ckb-ccc/connector-react";
import { TranfrClient, NOMINAL_HOURS_PER_EPOCH } from "../../sdk/src/index.js";

export const client = new ccc.ClientPublicTestnet();
export const tranfr = new TranfrClient({ client });

export const EXPLORER_URL = "https://pudge.explorer.nervos.org";

export function txUrl(txHash: string): string {
  return `${EXPLORER_URL}/transaction/${txHash}`;
}

export function generatePrivateKey(): ccc.Hex {
  return ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32)));
}

export function normalizePrivateKey(input: string): ccc.Hex | undefined {
  const trimmed = input.trim();
  const hex = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? (hex.toLowerCase() as ccc.Hex) : undefined;
}

export interface KeyIdentity {
  privateKey: ccc.Hex;
  script: ccc.Script;
  lockHash: ccc.Hex;
  address: string;
}

/** The lock checks signatures against the key's default secp256k1_blake160 lock, so that is the identity. */
export async function identityOf(privateKey: ccc.Hex): Promise<KeyIdentity> {
  const address = await new ccc.SignerCkbPrivateKey(client, privateKey).getAddressObjSecp256k1();
  return { privateKey, script: address.script, lockHash: address.script.hash(), address: address.toString() };
}

export async function scriptFromAddress(address: string): Promise<ccc.Script> {
  return (await ccc.Address.fromString(address.trim(), client)).script;
}

/** Sends a fully signed transaction and waits until it is committed. */
export async function sendAndWait(tx: ccc.Transaction): Promise<ccc.Hex> {
  const txHash = await client.sendTransaction(tx);
  await client.waitTransaction(txHash, 0, 180_000);
  return txHash;
}

export function epochToNumber(epoch: ccc.Epoch): number {
  const denominator = Number(epoch.denominator);
  return Number(epoch.integer) + (denominator === 0 ? 0 : Number(epoch.numerator) / denominator);
}

export function sinceToEpoch(since: bigint): ccc.Epoch {
  return ccc.Epoch.fromNum(since & 0x00ff_ffff_ffff_ffffn);
}

export function formatEpoch(epoch: ccc.Epoch): string {
  return `${epoch.integer} + ${epoch.numerator}/${epoch.denominator}`;
}

export interface ChainClock {
  tipEpoch: number;
  tipTimestampMs: number;
  msPerEpoch: number;
  /** True when the live sample failed and the nominal 4h epoch was used instead. */
  nominal: boolean;
}

const EPOCH_SAMPLE_BLOCKS = 2000n;

/**
 * Epoch wall-clock length drifts with difficulty adjustment (docs/epoch-length.md),
 * so countdowns use the live rate over the last ~2000 blocks, not a constant.
 */
export async function readChainClock(): Promise<ChainClock> {
  const tip = await client.getTipHeader();
  const tipEpoch = epochToNumber(tip.epoch);
  const pastNumber = tip.number > EPOCH_SAMPLE_BLOCKS ? tip.number - EPOCH_SAMPLE_BLOCKS : 0n;
  const past = await client.getHeaderByNumber(pastNumber);

  const epochsElapsed = past ? tipEpoch - epochToNumber(past.epoch) : 0;
  if (past && epochsElapsed > 0) {
    return {
      tipEpoch,
      tipTimestampMs: Number(tip.timestamp),
      msPerEpoch: Number(tip.timestamp - past.timestamp) / epochsElapsed,
      nominal: false,
    };
  }
  return {
    tipEpoch,
    tipTimestampMs: Number(tip.timestamp),
    msPerEpoch: NOMINAL_HOURS_PER_EPOCH * 3_600_000,
    nominal: true,
  };
}

export function estimateEpochTimeMs(clock: ChainClock, epoch: number): number {
  return clock.tipTimestampMs + (epoch - clock.tipEpoch) * clock.msPerEpoch;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function shortHex(hex: string, chars = 8): string {
  return hex.length <= chars * 2 + 2 ? hex : `${hex.slice(0, chars + 2)}…${hex.slice(-chars)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
