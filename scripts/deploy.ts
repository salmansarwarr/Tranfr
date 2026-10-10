import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as ccc from "@ckb-ccc/core";

const DEFAULT_RPC_URL = "https://testnet.ckb.dev/";
const EXPECTED_GENESIS_HASH = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
const EXPECTED_BINARY_PATH = "build/release/tranfr-lock";
const EXPECTED_SIZE = 108600;
const EXPECTED_SHA256 = "866da13128580f22d9bcf713ffd1f2fb6286bf512e2870744ccdb9d7288feb0e";
const EXPECTED_DATA_HASH = "0x24a5f576896042fa4583b9536189edfd21731c3d82f29ba28395a8145d77da3d";

interface CliOptions {
  binaryPath: string;
  rpcUrl: string;
  privateKey?: string;
  dryRun: boolean;
  updateDocs: boolean;
  generateKey: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    binaryPath: EXPECTED_BINARY_PATH,
    rpcUrl: process.env.CKB_RPC_URL || DEFAULT_RPC_URL,
    privateKey: process.env.CKB_TESTNET_PRIVATE_KEY,
    dryRun: false,
    updateDocs: true,
    generateKey: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--binary" && i + 1 < args.length) {
      options.binaryPath = args[++i];
    } else if (arg === "--rpc" && i + 1 < args.length) {
      options.rpcUrl = args[++i];
    } else if ((arg === "--key" || arg === "--private-key") && i + 1 < args.length) {
      options.privateKey = args[++i];
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--generate-key") {
      options.generateKey = true;
    } else if (arg === "--no-update-docs") {
      options.updateDocs = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Tranfr Testnet Deployment Script

Usage:
  npx tsx scripts/deploy.ts [options]

Options:
  --key, --private-key <hex>  Deployer private key (default: CKB_TESTNET_PRIVATE_KEY env)
  --generate-key              Generate a fresh deployment key & testnet address
  --binary <path>             Path to contract binary (default: ${EXPECTED_BINARY_PATH})
  --rpc <url>                 CKB RPC endpoint (default: ${DEFAULT_RPC_URL})
  --dry-run                   Validate environment and binary without broadcasting
  --no-update-docs            Do not update docs/deployment.md on success
  -h, --help                  Show this help message
      `);
      process.exit(0);
    }
  }

  return options;
}

function formatCkb(shannons: bigint): string {
  const whole = shannons / 100_000_000n;
  const frac = (shannons % 100_000_000n).toString().padStart(8, "0");
  return `${whole}.${frac} CKB`;
}

function updateDeploymentDocs(params: {
  network: string;
  genesisHash: string;
  txHash: string;
  index: number;
  codeHash: string;
  hashType: string;
  dataHash: string;
  size: number;
}) {
  const docPath = path.resolve("docs/deployment.md");
  if (!fs.existsSync(docPath)) return;

  const content = fs.readFileSync(docPath, "utf-8");
  const updated = content
    .replace(
      /## Status: .*/,
      `## Status: DEPLOYED (Testnet)\n\nDeployed transaction: \`${params.txHash}\` (output index ${params.index})`
    )
    .replace(
      /\| Network \/ genesis \| .*/,
      `| Network / genesis | \`${params.network}\` (\`${params.genesisHash}\`) |`
    )
    .replace(/\| tx_hash \| .*/, `| tx_hash | \`${params.txHash}\` |`)
    .replace(/\| index \| .*/, `| index | \`${params.index}\` |`)
    .replace(/\| code_hash \(type id\) \| .*/, `| code_hash (type id) | \`${params.codeHash}\` |`)
    .replace(/\| hash_type \| .*/, `| hash_type | \`${params.hashType}\` |`);

  fs.writeFileSync(docPath, updated, "utf-8");
  console.log(`[+] docs/deployment.md successfully updated with deployment results.`);
}

async function main() {
  const options = parseArgs();
  console.log("==================================================");
  console.log("       Tranfr Testnet Deployment (Step 10)        ");
  console.log("==================================================");

  if (options.generateKey) {
    const client = new ccc.ClientPublicTestnet(options.rpcUrl);
    const randomBytes = crypto.randomBytes(32);
    const key = `0x${randomBytes.toString("hex")}`;
    const signer = new ccc.SignerCkbPrivateKey(client, key);
    const address = await signer.getRecommendedAddress();

    console.log("\n[+] Generated Fresh Deployment Key:");
    console.log("--------------------------------------------------");
    console.log(`Private Key: ${key}`);
    console.log(`Address:     ${address}`);
    console.log("--------------------------------------------------");
    console.log("\nNext steps:");
    console.log("1. Send ~108,730 CKB to this address from JoyID or claim from https://faucet.nervos.org/");
    console.log(`2. Once funded, deploy with:\n   CKB_TESTNET_PRIVATE_KEY=${key} npm run deploy`);
    console.log("--------------------------------------------------");
    process.exit(0);
  }

  // 1. Verify binary
  const resolvedBinaryPath = path.resolve(options.binaryPath);
  if (!fs.existsSync(resolvedBinaryPath)) {
    console.error(`[!] Binary not found at: ${resolvedBinaryPath}`);
    console.error(`    Run 'make build CONTRACT=tranfr-lock' first.`);
    process.exit(1);
  }

  const binary = fs.readFileSync(resolvedBinaryPath);
  const sha256Hash = crypto.createHash("sha256").update(binary).digest("hex");
  const dataHash = ccc.hashCkb(binary);

  console.log("\n1. Contract Binary Verification:");
  console.log(`   Path:    ${options.binaryPath}`);
  console.log(`   Size:    ${binary.length} bytes ${binary.length === EXPECTED_SIZE ? "✓ (matches recorded)" : "(! size differs)"}`);
  console.log(`   SHA256:  ${sha256Hash} ${sha256Hash === EXPECTED_SHA256 ? "✓" : "(!)"}`);
  console.log(`   Blake2b: ${dataHash} ${dataHash === EXPECTED_DATA_HASH ? "✓" : "(!)"}`);

  // 2. Connect to RPC and verify testnet identity
  console.log("\n2. Connecting to CKB Network:");
  console.log(`   RPC URL: ${options.rpcUrl}`);
  const client = new ccc.ClientPublicTestnet(options.rpcUrl);

  let genesisHash: string;
  let chainName: string;
  try {
    const rawClient = client as unknown as {
      request?: (method: string, params: unknown[]) => Promise<unknown>;
    };
    if (typeof rawClient.request === "function") {
      genesisHash = (await rawClient.request("get_block_hash", ["0x0"])) as string;
      const info = (await rawClient.request("get_blockchain_info", [])) as { chain: string };
      chainName = info.chain;
    } else {
      const header = await client.getHeaderByNumber(0n);
      genesisHash = header?.hash || EXPECTED_GENESIS_HASH;
      chainName = "ckb_testnet";
    }
  } catch {
    const header = await client.getHeaderByNumber(0n);
    genesisHash = header?.hash || EXPECTED_GENESIS_HASH;
    chainName = "ckb_testnet";
  }

  console.log(`   Chain:        ${chainName}`);
  console.log(`   Genesis Hash: ${genesisHash}`);
  if (genesisHash.toLowerCase() === EXPECTED_GENESIS_HASH.toLowerCase()) {
    console.log(`   Identity:     ✓ Confirmed official CKB Testnet (Pudge)`);
  } else {
    console.warn(`   [!] Warning: Genesis hash does not match expected official testnet!`);
  }

  // 3. Check for private key
  if (!options.privateKey) {
    console.log("\n--------------------------------------------------");
    console.log("[i] No private key provided.");
    console.log("    To execute the deployment, run with your funded testnet key:");
    console.log("\n    CKB_TESTNET_PRIVATE_KEY=0x<your-hex-private-key> npm run deploy");
    console.log("    or");
    console.log("    npx tsx scripts/deploy.ts --key 0x<your-hex-private-key>");
    console.log("\n    Estimated funding requirement:");
    console.log(`    Capacity: ~108,726 CKB (~${binary.length} bytes cell data + header)`);
    console.log("    Faucet:   https://faucet.nervos.org/");
    console.log("--------------------------------------------------");
    process.exit(0);
  }

  // 4. Initialize Signer
  let formattedKey = options.privateKey.trim();
  if (!formattedKey.startsWith("0x")) {
    formattedKey = `0x${formattedKey}`;
  }

  const signer = new ccc.SignerCkbPrivateKey(client, formattedKey);
  const deployerAddress = await signer.getRecommendedAddress();
  const addressObj = await signer.getRecommendedAddressObj();
  const deployerLock = addressObj.script;

  console.log("\n3. Deployer Account:");
  console.log(`   Address: ${deployerAddress}`);

  const balance = await signer.getBalance();
  console.log(`   Balance: ${formatCkb(balance)} (${balance} Shannons)`);

  // Calculate required capacity for output cell
  const typeIdScriptTemplate = await client.getKnownScript(ccc.KnownScript.TypeId);
  const dummyType = new ccc.Script(
    typeIdScriptTemplate.codeHash,
    "type",
    "0x" + "00".repeat(32)
  );
  const sampleOutput = new ccc.CellOutput(0n, deployerLock, dummyType);
  const cellOccupiedBytes = sampleOutput.occupiedSize + binary.length;
  const requiredCapacity = BigInt(cellOccupiedBytes) * 100_000_000n;

  console.log(`   Required Cell Capacity: ${formatCkb(requiredCapacity)} (${cellOccupiedBytes} bytes)`);

  if (balance < requiredCapacity) {
    console.error(`\n[!] Insufficient balance:`);
    console.error(`    Available: ${formatCkb(balance)}`);
    console.error(`    Required:  ${formatCkb(requiredCapacity)} + fee`);
    console.error(`    Please request testnet CKB from https://faucet.nervos.org/ for:`);
    console.error(`    ${deployerAddress}`);
    process.exit(1);
  }

  if (options.dryRun) {
    console.log("\n[i] Dry-run enabled. Balance is sufficient. Skipping broadcast.");
    process.exit(0);
  }

  // 5. Construct Deployment Transaction with Type ID
  console.log("\n4. Constructing Type ID Deployment Transaction...");
  const tx = ccc.Transaction.from({
    outputs: [
      {
        lock: deployerLock,
        type: dummyType,
        capacity: requiredCapacity,
      },
    ],
    outputsData: [ccc.hexFrom(binary)],
  });

  console.log("   Selecting inputs to cover capacity...");
  await tx.completeInputsByCapacity(signer);

  if (tx.inputs.length === 0) {
    throw new Error("Failed to gather transaction inputs");
  }

  // Compute Type ID args: blake2b(inputs[0].to_bytes() || output_index.to_le_u64())
  const typeIdArgs = ccc.hashTypeId(tx.inputs[0], 0n);
  const deployedTypeScript = new ccc.Script(
    typeIdScriptTemplate.codeHash,
    "type",
    typeIdArgs
  );
  tx.outputs[0].type = deployedTypeScript;

  // Complete fee
  console.log("   Calculating fee and change...");
  await tx.completeFeeBy(signer, 1000);

  const deployedCodeHash = deployedTypeScript.hash();
  console.log(`   Computed Type ID code_hash: ${deployedCodeHash}`);
  console.log(`   Inputs count: ${tx.inputs.length}`);
  console.log(`   Outputs count: ${tx.outputs.length}`);

  // 6. Sign and Send Transaction
  console.log("\n5. Broadcasting Transaction to Testnet...");
  const txHash = await signer.sendTransaction(tx);
  console.log(`   [✓] Transaction broadcasted!`);
  console.log(`   Tx Hash: ${txHash}`);
  console.log(`   Explorer: https://pudge.explorer.nervos.org/transaction/${txHash}`);

  console.log("\n6. Waiting for confirmation on-chain...");
  await client.waitTransaction(txHash);
  console.log("   [✓] Transaction confirmed on-chain!");

  console.log("\n==================================================");
  console.log("             DEPLOYMENT SUCCESSFUL                ");
  console.log("==================================================");
  console.log(`Network:             ${chainName}`);
  console.log(`Transaction Hash:    ${txHash}`);
  console.log(`Output Index:        0`);
  console.log(`code_hash (Type ID): ${deployedCodeHash}`);
  console.log(`hash_type:           type`);
  console.log(`data_hash:           ${dataHash}`);
  console.log("==================================================");

  if (options.updateDocs) {
    updateDeploymentDocs({
      network: chainName,
      genesisHash,
      txHash,
      index: 0,
      codeHash: deployedCodeHash,
      hashType: "type",
      dataHash,
      size: binary.length,
    });
  }
}

main().catch((err) => {
  console.error("\n[!] Deployment error:", err);
  process.exit(1);
});
