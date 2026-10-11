import * as ccc from "@ckb-ccc/core";
import { TranfrConfig } from "./types.js";
import { TRANFR_TESTNET_CONFIG } from "./config.js";

/**
 * High-level Tranfr SDK client built on top of CCC (ckb-devrel/ccc).
 * Handles script construction, network RPC interaction, and cell querying.
 */
export class TranfrClient {
  public readonly client: ccc.Client;
  public readonly config: TranfrConfig;

  constructor(options?: { client?: ccc.Client; config?: TranfrConfig }) {
    this.client = options?.client ?? new ccc.ClientPublicTestnet();
    this.config = options?.config ?? TRANFR_TESTNET_CONFIG;
  }

  /**
   * Constructs the on-chain Tranfr lock Script instance with the specified args.
   */
  public getScript(args: ccc.Hex): ccc.Script {
    return new ccc.Script(this.config.codeHash, this.config.hashType, args);
  }

  /**
   * Returns the CellDep needed to execute transactions spending tranfr-lock cells.
   */
  public getCellDep(): ccc.CellDep {
    return ccc.CellDep.from(this.config.cellDep);
  }

  /**
   * Fetches the current tip epoch information from the connected CKB node.
   */
  public async getTipEpoch(): Promise<ccc.Epoch> {
    const header = await this.client.getTipHeader();
    return header.epoch;
  }
}
