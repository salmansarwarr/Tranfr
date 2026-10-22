import { test, expect } from "@playwright/test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { installTestWallet } from "./test-wallet";

// No transactions: connects a test wallet and checks the Create panel's Copy address button.
test("Copy address puts the connected wallet's full address on the clipboard", async ({ browser }) => {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  await installTestWallet(page, secp256k1.utils.randomSecretKey());
  await page.goto("/");

  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByText("Tranfr Test Wallet").click();
  const panel = page.locator("section.card", { hasText: "Create a Tranfr cell" });
  const address = await panel.locator("span.mono[title]").getAttribute("title");
  expect(address).toMatch(/^ckt1/);

  await panel.getByRole("button", { name: "Copy address", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate("navigator.clipboard.readText()")).toBe(address);
  await expect(panel.getByRole("button", { name: "Copy address", exact: true })).toBeVisible({ timeout: 5000 });

  await page.screenshot({ path: test.info().outputPath("copy-address.png") });
  await context.close();
});
