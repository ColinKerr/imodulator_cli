import type { Server } from "node:http";
import express from "express";
import { IModelDb } from "@itwin/core-backend";
import { IModelReadRpcInterface, IModelTileRpcInterface } from "@itwin/core-common";
import { BentleyCloudRpcConfiguration, BentleyCloudRpcManager } from "@itwin/core-common";
import { ECSchemaRpcInterface } from "@itwin/ecschema-rpcinterface-common";
import { ECSchemaRpcImpl } from "@itwin/ecschema-rpcinterface-impl";
import { getCacheDir } from "../cache/cache-dir";
import { startIModelHost } from "../host/imodel-host";
import { noopAuthClient } from "../auth/noop-auth-client";
import { DEFAULT_KEY, listCacheIModels, openForServe, openOrReuse, resolveIModelKey, type KeySource } from "./open-for-serve";

export const DEFAULT_PORT = 3001;

export interface BackendServerArgs {
  /** 0 asks the OS for any free port, which the result reports back. */
  port?: number;
  /** Opened at startup under {@link DEFAULT_KEY}. */
  imodelPath?: string;
}

export interface RunningServer {
  port: number;
  url: string;
  /** The iModel opened by `--imodel-path`, if one was given. */
  defaultIModel?: { key: string; filePath: string };
  /** Stop listening and close every iModel this server opened. */
  close(): Promise<void>;
}

/** What the custom open endpoint returns alongside the connection props. */
export interface OpenIModelResponse {
  key: string;
  filePath: string;
  source: KeySource;
  opened: boolean;
  connectionProps: unknown;
}

/**
 * An iTwin.js RPC backend for local use.
 *
 * No authorization is checked anywhere: the server is meant to be reachable only from
 * localhost, and the iModels it serves are local files that never involve the hub. The
 * backend does not validate tokens in any case -- it passes whatever arrives in the
 * Authorization header straight through, and a locally opened iModel ignores it.
 */
export async function startBackendServer(args: BackendServerArgs = {}): Promise<RunningServer> {
  await startIModelHost(noopAuthClient);

  // IModelHost.startup registers the read, tile and snapshot implementations itself; the
  // schema one is ours to register.
  ECSchemaRpcImpl.register();

  const rpcConfig = BentleyCloudRpcManager.initializeImpl(
    { info: { title: "imodulator", version: "v1.0" } },
    [IModelReadRpcInterface, IModelTileRpcInterface, ECSchemaRpcInterface],
  );

  // The keys this server has opened, so it can report them; IModelDb offers no public
  // enumeration of open connections.
  const opened = new Map<string, string>();

  const app = express();
  app.use(express.text());
  app.use(express.json());

  app.all(/.*/, (req, res, next) => {
    res.header("Access-Control-Allow-Origin", BentleyCloudRpcConfiguration.accessControl.allowOrigin);
    res.header("Access-Control-Allow-Methods", BentleyCloudRpcConfiguration.accessControl.allowMethods);
    res.header("Access-Control-Allow-Headers", BentleyCloudRpcConfiguration.accessControl.allowHeaders);
    // The console is served from a different port, and RPC sends custom X- headers, so every
    // call is preceded by a preflight. Answering it here stops it falling through to the RPC
    // catch-all, which would reject it.
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  /** Identifies this server to `imod serve`, and lets the console check it is reachable. */
  app.get("/health", (_req, res) => {
    // The cache directory is reported so a caller can tell which cache this server holds
    // open. A server on the wrong one locks the workspace profile for everything else.
    res.json({ server: "backend", open: opened.size, cacheDir: getCacheDir() });
  });

  /**
   * Open an iModel and report the props a client needs to connect to it.
   *
   * The key is the iModel's path, or `<imodelId>/<briefcaseId>` or `<imodelId>/<changesetId>`
   * for one in the cache. Every later RPC call carries the same key, which the standard
   * backend resolves through `IModelDb.findByKey`, so nothing further is needed here.
   */
  app.post("/open", async (req, res) => {
    const key = (typeof req.body === "object" ? req.body?.key : undefined) ?? req.query.key;
    if (typeof key !== "string" || key.length === 0) {
      res.status(400).json({ error: "Supply the iModel to open as `key`, either a file path or a cache id." });
      return;
    }
    try {
      const result = await openOrReuse(key);
      // Report the path actually open rather than the one asked for: they differ wherever
      // the path traverses a symlink.
      const filePath = result.db.pathName;
      opened.set(result.key, filePath);
      const response: OpenIModelResponse = {
        key: result.key,
        filePath,
        source: result.source,
        opened: result.opened,
        connectionProps: result.db.getConnectionProps(),
      };
      res.json(response);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * What a client can open: the iModels already open here, and everything in the cache.
   * The console's picker is built from this.
   */
  app.get("/imodels", (_req, res) => {
    res.json({
      open: [...opened].map(([key, filePath]) => ({ key, filePath })),
      available: listCacheIModels(),
    });
  });

  // Express 5 rejects a bare "*" path, so the RPC catch-alls are regular expressions. The
  // GET route is not optional: tile content comes back through it.
  app.get("/v3/swagger.json", (req, res) => rpcConfig.protocol.handleOpenApiDescriptionRequest(req, res));
  app.post(/.*/, async (req, res) => rpcConfig.protocol.handleOperationPostRequest(req, res));
  app.get(/\/imodel\//, async (req, res) => rpcConfig.protocol.handleOperationGetRequest(req, res));
  app.use(/.*/, (_req, res) => res.send("<h1>imodulator iTwin.js RPC server</h1>"));

  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(args.port ?? DEFAULT_PORT, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (args.port ?? DEFAULT_PORT);

  let defaultIModel: RunningServer["defaultIModel"];
  if (args.imodelPath !== undefined) {
    try {
      // Opened under the default key rather than its path, so a client can connect without
      // being told where the file lives.
      const { filePath } = resolveIModelKey(args.imodelPath);
      const db = await openForServe(filePath, DEFAULT_KEY);
      opened.set(DEFAULT_KEY, db.pathName);
      defaultIModel = { key: DEFAULT_KEY, filePath: db.pathName };
    } catch (err) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw err;
    }
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    defaultIModel,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Release the files: an iModel left open outlives the server that opened it, and the
      // next server would find it already open under the same key.
      for (const key of opened.keys())
        IModelDb.tryFindByKey(key)?.close();
      opened.clear();
    },
  };
}
