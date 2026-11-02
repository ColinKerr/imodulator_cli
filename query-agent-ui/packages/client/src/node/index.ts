/**
 * The client in Node, with the queries going to a backend by RPC, exactly as a browser's do. For
 * tests and scripts that drive the agent the way the UI does, without a browser.
 *
 * iTwin.js's frontend needs a DOM to start, so a DOM shim (`global-jsdom`) is loaded first, as
 * iTwin.js's own Node frontend tests do. Without it `NoRenderApp.startup` fails with "window is
 * not defined", and a bare `window` object is not enough for the RPC requests (researched and
 * tested 2026-10-28).
 *
 * ```ts
 * await startNodeFrontend(backendUrl);
 * const imodel = connectionFromProps(propsTheBackendGaveForTheOpenIModel);
 * const client = AgentClient.start({ runQuery: queryRunner(imodel), imodelName, functionUrl });
 * ```
 */

import { BentleyCloudRpcManager, IModelReadRpcInterface, type IModelConnectionProps, type RpcInterfaceDefinition } from "@itwin/core-common";
import { IModelConnection, NoRenderApp } from "@itwin/core-frontend";

let started: string | undefined;

/**
 * Start iTwin.js's frontend in this process, talking to the backend at `backendUrl`
 * (`BentleyCloudRpcManager`). Once per process; a second call with another URL throws.
 */
export async function startNodeFrontend(backendUrl: string, options: { title?: string; version?: string; interfaces?: RpcInterfaceDefinition[] } = {}): Promise<void> {
  if (started !== undefined) {
    if (started !== backendUrl)
      throw new Error(`The frontend is already started for ${started}.`);
    return;
  }
  if (typeof (globalThis as { window?: unknown }).window === "undefined")
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("global-jsdom") as () => void)();
  BentleyCloudRpcManager.initializeClient(
    { info: { title: options.title ?? "imodulator", version: options.version ?? "v1.0" }, uriPrefix: backendUrl },
    options.interfaces ?? [IModelReadRpcInterface],
  );
  await NoRenderApp.startup({ applicationId: "query-agent-client" });
  started = backendUrl;
}

/** An `IModelConnection` for an iModel the backend already has open, from the props it gave for it. */
class OpenConnection extends IModelConnection {
  private closed = false;

  public constructor(props: IModelConnectionProps) {
    super(props);
  }

  public override get isClosed(): boolean {
    return this.closed;
  }

  public override async close(): Promise<void> {
    if (this.closed)
      return;
    this.closed = true;
    this.beforeClose();
  }
}

export function connectionFromProps(props: IModelConnectionProps): IModelConnection {
  return new OpenConnection(props);
}
