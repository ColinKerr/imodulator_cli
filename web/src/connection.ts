import {
  IModelApp, IModelConnection,
} from "@itwin/core-frontend";
import {
  BentleyCloudRpcManager, IModelReadRpcInterface, IModelTileRpcInterface,
  type IModelConnectionProps,
} from "@itwin/core-common";
import { ECSchemaRpcInterface } from "@itwin/ecschema-rpcinterface-common";

/**
 * A connection to an iModel that `imod serve backend` already has open.
 *
 * IModelConnection's constructor is protected and it has only two abstract members, so this
 * is all that is needed to wrap the props the backend's open endpoint returns. Every read
 * then goes through the standard RPC interfaces, which resolve the key with
 * `IModelDb.findByKey` on the backend.
 *
 * Note this deliberately never calls `IModelReadRpcInterface.getConnectionProps`: that is the
 * one read operation which tries to download a checkpoint from iModelHub instead of using the
 * already open iModel.
 */
export class ServedIModelConnection extends IModelConnection {
  private _closed = false;

  public constructor(props: IModelConnectionProps) {
    super(props);
  }

  public override get isClosed(): boolean {
    return this._closed;
  }

  public override async close(): Promise<void> {
    if (this._closed)
      return;
    this._closed = true;
    this.beforeClose();
  }
}

export interface ConsoleConfig {
  backendUrl?: string;
  backendRunning: boolean;
  imodelPath?: string;
}

export async function loadConfig(): Promise<ConsoleConfig> {
  const response = await fetch("./config.json");
  return response.json() as Promise<ConsoleConfig>;
}

/** Point the RPC client at the backend and start the frontend. */
export async function startFrontend(backendUrl: string): Promise<void> {
  BentleyCloudRpcManager.initializeClient(
    { info: { title: "imodulator", version: "v1.0" }, uriPrefix: backendUrl },
    [IModelReadRpcInterface, IModelTileRpcInterface, ECSchemaRpcInterface],
  );
  await IModelApp.startup({ applicationId: "imodulator-console" });
}

export interface OpenResponse {
  key: string;
  filePath: string;
  source: string;
  opened: boolean;
  connectionProps: IModelConnectionProps;
}

export interface AvailableIModel {
  key: string;
  filePath: string;
  source: string;
  imodelId: string;
  version: string;
}

/** What the backend has open, and what it could open from the cache. */
export async function listIModels(backendUrl: string): Promise<{
  open: { key: string; filePath: string }[];
  available: AvailableIModel[];
}> {
  const response = await fetch(`${backendUrl}/imodels`);
  if (!response.ok)
    throw new Error(`The backend could not list iModels (${response.status}).`);
  return response.json();
}

/** Ask the backend to open a key, then wrap the result as a connection. */
export async function openIModel(backendUrl: string, key: string): Promise<ServedIModelConnection> {
  const response = await fetch(`${backendUrl}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const body = (await response.json()) as OpenResponse & { error?: string };
  if (!response.ok)
    throw new Error(body.error ?? `The backend could not open "${key}".`);
  return new ServedIModelConnection(body.connectionProps);
}
