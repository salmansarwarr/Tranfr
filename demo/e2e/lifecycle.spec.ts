import { test, expect, type Page, type Locator } from "@playwright/test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ccc } from "@ckb-ccc/connector-react";
import fs from "node:fs";
import path from "node:path";
import { installTestWallet } from "./test-wallet";

/**
 * Click-through of the demo against CKB testnet, in two phases:
 *
 *   E2E_DIR=<dir> FUNDER_KEYS=<keys.json> PHASE=start  npx playwright test e2e/lifecycle.spec.ts
 *   E2E_DIR=<dir>                         PHASE=finish npx playwright test e2e/lifecycle.spec.ts
 *
 * `start` drives the UI to generate owner and recipient keys, connect a wallet
 * through the CCC connector, create cells A, B and C with a 1-epoch deadline,
 * renew A, reclaim C, and checks A's Claim button is disabled. `finish` waits
 * until the app shows A and B as claimable, then claims A and reclaims B.
 *
 * E2E_DIR receives the browser storage (it holds the demo's testnet keys), the
 * wallet key, screenshots, and a JSON log of every transaction. Keep it out of
 * the repo. FUNDER_KEYS is a funded testnet key used only to top up the test
 * wallet, standing in for the faucet.
 */

const DIR = process.env.E2E_DIR!;
const PHASE = process.env.PHASE;
const EXPLORER = "https://pudge.explorer.nervos.org/transaction/";
const STORAGE = () => path.join(DIR, "storage-state.json");
const LOG = () => path.join(DIR, "e2e-log.json");
const WALLET = () => path.join(DIR, "wallet-key.json");

interface E2ELog {
  addresses: Record<string, string>;
  cells: Record<string, string>;
  steps: { step: string; at: string; txHash?: string; explorer?: string; note?: string }[];
}

function loadLog(): E2ELog {
  return fs.existsSync(LOG()) ? JSON.parse(fs.readFileSync(LOG(), "utf8")) : { addresses: {}, cells: {}, steps: [] };
}

function record(log: E2ELog, step: string, txHash?: string, note?: string) {
  log.steps.push({ step, at: new Date().toISOString(), txHash, explorer: txHash && EXPLORER + txHash, note });
  fs.writeFileSync(LOG(), JSON.stringify(log, null, 2));
  console.log(`${step}${txHash ? ` ${txHash}` : ""}${note ? ` (${note})` : ""}`);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(DIR, `${name}.png`), fullPage: true });
}

/** Waits for a new Activity entry with `message` and returns the tx hash it links to. */
async function awaitActivity(page: Page, message: string, timeout = 300_000): Promise<string> {
  const entry = page.locator("ul.log li", { hasText: message }).first();
  await expect(entry).toBeVisible({ timeout });
  const href = await entry.locator("a").getAttribute("href");
  return href!.slice(href!.lastIndexOf("/") + 1);
}

/** A cell's card, found by the out-point link in its heading (the Activity panel also links tx hashes). */
function cellCard(page: Page, txHash: string): Locator {
  return page.locator("section.card").filter({ has: page.locator(`h3 a[href="${EXPLORER}${txHash}"]`) });
}

async function countActivity(page: Page, message: string) {
  return page.locator("ul.log li", { hasText: message }).count();
}

async function fundAddress(address: string, ckb: number) {
  const keys = JSON.parse(fs.readFileSync(process.env.FUNDER_KEYS!, "utf8"));
  const client = new ccc.ClientPublicTestnet();
  const funder = new ccc.SignerCkbPrivateKey(client, keys.funder.privateKey);
  const to = await ccc.Address.fromString(address, client);
  const tx = ccc.Transaction.from({ outputs: [{ lock: to.script, capacity: ccc.fixedPointFrom(ckb) }] });
  await tx.completeInputsByCapacity(funder);
  await tx.completeFeeBy(funder);
  const txHash = await funder.sendTransaction(tx);
  await client.waitTransaction(txHash, 0, 300_000);
  return txHash;
}

async function connectTestWallet(page: Page) {
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByText("Tranfr Test Wallet").click();
  const panel = page.locator("section.card", { hasText: "Create a Tranfr cell" });
  await expect(panel.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  return panel;
}

test("start: keys, wallet, create A/B/C, renew A, reclaim C", async ({ browser }) => {
  test.skip(PHASE !== "start", "run with PHASE=start");
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(LOG())) throw new Error(`${LOG()} exists; use a fresh E2E_DIR`);

  const walletKey = secp256k1.utils.randomSecretKey();
  fs.writeFileSync(WALLET(), JSON.stringify({ privateKey: ccc.hexFrom(walletKey) }), { mode: 0o600 });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log("page error:", err.message));
  await installTestWallet(page, walletKey);
  await page.goto("/");
  const log = loadLog();

  // The demo keeps its keys and tracked cells in localStorage: save it after every
  // step, so a failure can never lose the keys guarding cells already on chain.
  const persist = async () => {
    await context.storageState({ path: STORAGE() });
    fs.chmodSync(STORAGE(), 0o600);
  };

  // 1. Keys, generated in the UI.
  for (const title of ["Owner key", "Recipient key"]) {
    const card = page.locator("section.card", { hasText: title });
    await card.getByRole("button", { name: "Generate key", exact: true }).click();
    const address = card.locator("dd").first();
    await expect(address).toContainText("ckt1", { timeout: 30_000 });
    log.addresses[title.split(" ")[0].toLowerCase()] = (await address.innerText()).trim();
  }
  await persist();

  // 2. Wallet through the CCC connector, topped up from the funder (faucet stand-in).
  let panel = await connectTestWallet(page);
  const walletAddress = (await panel.locator("span.mono[title]").getAttribute("title"))!;
  log.addresses.wallet = walletAddress;
  record(log, "fund test wallet (setup, not part of the demo)", await fundAddress(walletAddress, 1000));
  await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
  panel = await connectTestWallet(page);
  await expect(panel).toContainText("1000 CKB", { timeout: 60_000 });
  await shot(page, "01-keys-and-wallet");

  // 3. Create A, B, C through the Create form, each with a 1-epoch deadline.
  for (const name of ["A", "B", "C"]) {
    const before = await countActivity(page, "Tranfr cell created.");
    await panel.getByLabel("Capacity (CKB)").fill("200");
    await panel.getByRole("button", { name: "Use 1", exact: true }).click();
    await panel.getByRole("button", { name: "Create Tranfr cell", exact: true }).click();
    await expect(page.locator("ul.log li", { hasText: "Tranfr cell created." })).toHaveCount(before + 1, { timeout: 300_000 });
    const txHash = await awaitActivity(page, "Tranfr cell created.");
    log.cells[name] = txHash;
    record(log, `create ${name} (Create form, wallet-funded)`, txHash);
    await persist();
    await expect(cellCard(page, txHash).locator(".badge.ok")).toHaveText("Owner only", { timeout: 120_000 });
  }
  await shot(page, "02-three-cells");

  // 4. Renew A (heartbeat) with an explicit 1-epoch delay.
  const cardA = cellCard(page, log.cells.A);
  await expect(cardA.getByRole("button", { name: "Claim", exact: true })).toBeDisabled();
  record(log, "claim A before deadline: Claim button disabled in UI", undefined, "recipient key loaded, not yet claimable");
  await cardA.getByLabel("New delay (epochs, optional)").fill("1");
  await cardA.getByRole("button", { name: "Renew", exact: true }).click();
  const renewHash = await awaitActivity(page, "Renew committed.");
  log.cells.A = renewHash;
  record(log, "renew A (Renew button)", renewHash);
  await persist();
  await expect(cellCard(page, renewHash).locator(".badge.ok")).toHaveText("Owner only", { timeout: 120_000 });

  // 5. Owner reclaims C before its deadline.
  const cardC = cellCard(page, log.cells.C);
  await cardC.getByRole("button", { name: "Reclaim", exact: true }).click();
  record(log, "owner reclaim C before deadline (Reclaim button)", await awaitActivity(page, "Reclaim committed."));
  await expect(cardC).toHaveCount(0);
  delete log.cells.C;
  fs.writeFileSync(LOG(), JSON.stringify(log, null, 2));
  await shot(page, "03-after-renew-and-reclaim");

  await persist();
  await context.close();
});

test("finish: claim A as recipient, reclaim B as owner after the deadline", async ({ browser }) => {
  test.skip(PHASE !== "finish", "run with PHASE=finish");
  test.setTimeout(9 * 60 * 60_000);
  const log = loadLog();
  const context = await browser.newContext({ storageState: STORAGE() });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log("page error:", err.message));
  await page.goto("/");

  const cardA = cellCard(page, log.cells.A);
  const cardB = cellCard(page, log.cells.B);
  await expect(cardA.locator(".badge")).toBeVisible({ timeout: 120_000 });
  await shot(page, "03-phase2-start");
  // The app refreshes status every 30 s; wait for its own "Recipient can claim" badge.
  for (const card of [cardA, cardB]) {
    await expect(card.locator(".badge.warn")).toHaveText("Recipient can claim", { timeout: 8 * 60 * 60_000 });
  }
  await shot(page, "04-claimable");

  await cardA.getByRole("button", { name: "Claim", exact: true }).click();
  const claimHash = await awaitActivity(page, "Claim committed.");
  record(log, "recipient claim A after deadline (Claim button)", claimHash);
  await expect(cardA).toHaveCount(0);

  await cardB.getByRole("button", { name: "Reclaim", exact: true }).click();
  record(log, "owner reclaim B after deadline (Reclaim button)", await awaitActivity(page, "Reclaim committed."));
  await expect(cardB).toHaveCount(0);
  await shot(page, "05-done");

  // Independent check from the chain: the claim paid the recipient's address shown in the UI.
  const client = new ccc.ClientPublicTestnet();
  const claim = await client.getTransaction(claimHash);
  const recipient = await ccc.Address.fromString(log.addresses.recipient, client);
  expect(claim?.status).toBe("committed");
  expect(claim!.transaction.outputs[0].lock.eq(recipient.script)).toBe(true);
  record(
    log,
    "chain check: claim output pays the recipient",
    undefined,
    `${ccc.fixedPointToString(claim!.transaction.outputs[0].capacity)} CKB to ${log.addresses.recipient}`,
  );
  await context.close();
});
