import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { IModelDb } from "@itwin/core-backend";
import { IModelReadRpcInterface, IModelTileRpcInterface } from "@itwin/core-common";
import { BentleyCloudRpcConfiguration, BentleyCloudRpcManager } from "@itwin/core-common";
import { ECSchemaRpcInterface } from "@itwin/ecschema-rpcinterface-common";
import { ECSchemaRpcImpl } from "@itwin/ecschema-rpcinterface-impl";
import { HierarchyCacheMode, Presentation } from "@itwin/presentation-backend";
import { PresentationRpcInterface } from "@itwin/presentation-common";
import { getCacheDir } from "../cache/cache-dir";
import { startIModelHost } from "../host/imodel-host";
import { noopAuthClient } from "../auth/noop-auth-client";
import { openCachedVersion } from "./cached-versions";
import { itwinPlatformApi } from "./itwin-platform";
import { localSignIn } from "./local-sign-in";
import { DEFAULT_KEY, listCacheIModels, openForServe, openOrReuse, resolveIModelKey, type KeySource } from "./open-for-serve";

export const DEFAULT_PORT = 3001;

/** Where the local sign-in and the iTwin Platform API are served, under the server's URL. */
export const SIGN_IN_PATH = "/ims";
export const ITWIN_API_PATH = "/api";

export interface BackendServerArgs {
  /** 0 asks the OS for any free port, which the result reports back. */
  port?: number;
  /** Opened at startup under {@link DEFAULT_KEY}. */
  imodelPath?: string;
  /**
   * Also answer as a local sign-in and as the part of the iTwin Platform API a picker and a
   * viewer call, from the cache, so a standard iTwin.js web app can open cached iModels.
   * See {@link startBackendServer}.
   */
  itwinPlatform?: boolean;
  /** With `itwinPlatform`, the one web app origin allowed to use it. Any origin otherwise. */
  appOrigin?: string;
}

export interface RunningServer {
  port: number;
  url: string;
  /** The iModel opened by `--imodel-path`, if one was given. */
  defaultIModel?: { key: string; filePath: string };
  /** With `itwinPlatform`: the URLs to give a web app as its sign-in authority and iTwin Platform API. */
  itwinPlatform?: { signInUrl: string; apiUrl: string };
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
 *
 * With `itwinPlatform`, a web app made for the iTwin Platform -- its sign-in, iTwin and iModel
 * picker and viewer -- can be pointed here instead of at Bentley's services:
 *
 * - `/ims` is a local sign-in that needs no account;
 * - `/api` answers the iTwins, iModels and changesets calls from the cache;
 * - the RPC routes open a cached file the first time a client asks to connect to it at a
 *   changeset, under the key the standard open path looks for, so nothing is downloaded.
 */
export async function startBackendServer(args: BackendServerArgs = {}): Promise<RunningServer> {
  await startIModelHost(noopAuthClient);

  // IModelHost.startup registers the read, tile and snapshot implementations itself; the
  // schema one is ours to register.
  ECSchemaRpcImpl.register();
  startPresentation();

  const rpcConfig = BentleyCloudRpcManager.initializeImpl(
    { info: { title: "imodulator", version: "v1.0" } },
    [IModelReadRpcInterface, IModelTileRpcInterface, ECSchemaRpcInterface, PresentationRpcInterface],
  );

  // The keys this server has opened, so it can report them; IModelDb offers no public
  // enumeration of open connections.
  const opened = new Map<string, string>();

  const app = express();
  app.use(express.text());
  app.use(express.json());

  if (args.itwinPlatform) {
    // Above the RPC routes' CORS: these answer their own preflights, with the headers the
    // iTwin Platform clients send.
    app.use(SIGN_IN_PATH, localSignIn({ appOrigin: args.appOrigin }));
    app.use(ITWIN_API_PATH, itwinPlatformApi({ appOrigin: args.appOrigin }));
  }

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

  // Below the CORS headers, so a refusal reaches the browser as one rather than as a CORS error.
  if (args.itwinPlatform)
    app.use((req, res, next) => openOnConnect(req, res, next, opened));

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

  // Routes of our own go above here. `app.post(/.*/)` below hands every POST to the protocol
  // handler, so a route added after it is never reached, and fails in a way that looks nothing
  // like a routing mistake.

  // Express 5 rejects a bare "*" path, so the RPC catch-alls are regular expressions. The
  // GET route is not optional: tile content comes back through it.
  app.get("/v3/swagger.json", (req, res) => rpcConfig.protocol.handleOpenApiDescriptionRequest(req, res));
  app.post(/.*/, async (req, res) => rpcConfig.protocol.handleOperationPostRequest(req, res));
  app.get(/\/imodel\//, async (req, res) => rpcConfig.protocol.handleOperationGetRequest(req, res));
  app.use(/.*/, (_req, res) => res.send("<h1>imodulator iTwin.js RPC server</h1>"));

  // The `listening` event, not app.listen's callback argument: measured against a port that
  // was already taken, the callback fires anyway with a null address and the EADDRINUSE
  // arrives after it. Resolving there reports a server that never bound.
  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(args.port ?? DEFAULT_PORT, "127.0.0.1");
    listening.once("listening", () => resolve(listening));
    listening.once("error", reject);
  });

  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("The backend server reported no address after it began listening.");
  const port = address.port;

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

  const url = `http://127.0.0.1:${port}`;
  return {
    port,
    url,
    defaultIModel,
    itwinPlatform: args.itwinPlatform ? { signInUrl: `${url}${SIGN_IN_PATH}`, apiUrl: `${url}${ITWIN_API_PATH}` } : undefined,
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

let presentationStarted = false;

/**
 * Start presentation, so a viewer's property grid and other presentation components can be
 * served. Once per process, like IModelHost: tests start many servers in one.
 *
 * Hierarchies are cached in memory. The default is a file beside each iModel, which would
 * write into imodulator's cache.
 */
function startPresentation(): void {
  if (presentationStarted)
    return;
  Presentation.initialize({ caching: { hierarchies: { mode: HierarchyCacheMode.Memory } } });
  presentationStarted = true;
}

/** The RPC operation a client calls to connect to an iModel at a changeset. */
const GET_CONNECTION_PROPS = /\/IModelReadRpcInterface-[^/]+-getConnectionProps(\/|$)/;

/**
 * Before the standard `getConnectionProps` runs, open the cached file the client asks for
 * under the checkpoint key, where that lookup finds it.
 *
 * The iModel and changeset are read from the request's path, as the RPC protocol itself reads
 * them (`BentleyCloudRpcProtocol.inflateToken`): the path carries them for a GET and a POST
 * alike, and changeset "0" stands for the first version. When the cache holds no file at
 * that changeset the request is refused here, because the standard path would go on to
 * download a checkpoint from the iModel Hub.
 */
function openOnConnect(req: Request, res: Response, next: NextFunction, opened: Map<string, string>): void {
  if (!GET_CONNECTION_PROPS.test(req.path))
    return next();
  const parts = req.path.split("/");
  // The last occurrence, as the protocol takes it: the default route prefix is "imodel/rpc".
  const after = (name: string) => {
    const at = parts.lastIndexOf(name);
    return at >= 0 ? parts[at + 1] : undefined;
  };
  const iModelId = after("imodel");
  const routeChangeset = after("changeset");
  if (!iModelId || routeChangeset === undefined)
    return next();
  const changesetId = routeChangeset === "0" ? "" : routeChangeset;
  try {
    const result = openCachedVersion(iModelId, changesetId);
    if (!result) {
      res.status(404).json({ error: `The cache holds no file of iModel ${iModelId} at changeset "${changesetId}".` });
      return;
    }
    opened.set(result.key, result.db.pathName);
    next();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
