import type { Page } from "@playwright/test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ccc } from "@ckb-ccc/connector-react";

const { bytesConcat, bytesFrom, hexFrom } = ccc;

/**
 * A minimal EIP-1193 wallet announced over EIP-6963, standing in for MetaMask so
 * the demo's real CCC connector and Omnilock signing path can run headless.
 * It implements only what CCC's EIP-6963 signer calls: eth_requestAccounts,
 * eth_accounts and personal_sign. The key never enters the page: signing runs
 * in Node through an exposed function.
 */
export function ethAddressOf(privateKey: Uint8Array): string {
  return hexFrom(keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(12));
}

/** Standard personal_sign: r ‖ s ‖ v with v = 27 + recovery id (verified against ccc.verifyMessageEvmPersonal). */
export function personalSign(messageHex: string, privateKey: Uint8Array): string {
  const message = bytesFrom(messageHex);
  const prefix = bytesFrom(`\x19Ethereum Signed Message:\n${message.length}`, "utf8");
  const recovered = secp256k1.sign(keccak_256(bytesConcat(prefix, message)), privateKey, {
    prehash: false,
    format: "recovered",
  });
  // noble 2.x "recovered" layout is recovery ‖ r ‖ s.
  return hexFrom(bytesConcat(recovered.slice(1, 65), [recovered[0] + 27]));
}

export async function installTestWallet(page: Page, privateKey: Uint8Array) {
  const address = ethAddressOf(privateKey);
  await page.exposeFunction("__tranfrTestWalletSign", (messageHex: string) => personalSign(messageHex, privateKey));
  // Passed as a string: function sources would be transpiled with helpers (e.g. __name) the page lacks.
  await page.addInitScript(`
    (() => {
      const account = ${JSON.stringify(address)};
      const provider = {
        async request({ method, params }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
          if (method === "personal_sign") return window.__tranfrTestWalletSign(String(params[0]));
          throw new Error("Tranfr test wallet: unsupported method " + method);
        },
        on() {},
        removeListener() {},
      };
      const info = {
        uuid: "6f6a1b2c-0d4e-4f5a-9b8c-7d6e5f4a3b2c",
        name: "Tranfr Test Wallet",
        icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect width='1' height='1' fill='%231f6feb'/%3E%3C/svg%3E",
        rdns: "dev.tranfr.testwallet",
      };
      const announce = () =>
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    })();
  `);
  return address;
}
