# backend command details

Implementation details for the `imod serve backend` command

This command starts an iTwin.js server in another process outputs the details of the server and then returns so other commands can be run while the server is active.

## Options

- `--imodel-path` (Optional) - If specified the iModel at this path is automatically opened and registered with the key `default` that can be used by a client application to load this iModel.
- `--port` (Optional) - Port to listen on. Defaults to 3001. Pass `0` to bind any free port, which is reported in the command's output.
- `--stop` (Optional) - If specified the server process is found and killed.
- `--itwin-platform` (Optional) - Also answer as a local sign-in and as the part of the iTwin Platform API a picker and a viewer call, for the iModels in the cache. See [Serving a standard iTwin.js web app](#serving-a-standard-itwinjs-web-app).
- `--app-origin` (Optional) - With `--itwin-platform`, the one web app origin allowed to use the sign-in and API endpoints, such as `http://localhost:3000`. Any origin when not given.

## Implementation details

The backend exposes a custom endpoint that lets the client specify an iModel to open. This endpoint checks to see if the iModel is already opened, if not it opens the iModel and registers it with the supplied key and returns IModelConnectionProps.

```
POST /open   {"key": "<path or cache id>"}
```

The key is used verbatim as the iModel's key, because that is what the client sends back on every later RPC call. A key is one of:

| key | resolves to |
|---|---|
| a path to an iModel file | that file |
| `<imodelId>/<briefcaseId>` | the briefcase in the cache (`downloaded_briefcases`) |
| `<imodelId>/<changesetId>` | the checkpoint in the cache (`downloaded_checkpoints`) |

Paths are tried first, so a caller passing a real path always gets that file. A briefcase id is all digits and a changeset id is not, which is how the two cache forms are told apart.

`GET /imodels` lists the keys the server currently has open.

iModels are opened **read-only**. Checkpoints open as snapshots; briefcases do not, and fall back to a read-only `BriefcaseDb.open`.

### Why nothing more is needed to serve the opened iModel

Every read and tile operation resolves the key through `RpcBriefcaseUtility.findOpenIModel`, which is just `IModelDb.findByKey` — an in-memory lookup of the already-open iModel, with no call to the hub. So opening under a chosen key is the whole mechanism; no RPC implementation has to be replaced or patched.

`IModelDb.tryFindByKey` is what makes the endpoint idempotent — a second request for the same key reuses the open iModel rather than opening the file twice.

### One operation a client must avoid

`IModelReadRpcInterface.getConnectionProps` is the single read operation that does **not** resolve through `findOpenIModel`. It calls `RpcBriefcaseUtility.openWithTimeout`, which tries to download a checkpoint from iModelHub, and against this server it fails with *"V2 checkpoint not found: err: Unsupported access token format"*. Clients should take their connection props from `POST /open` instead. For the same reason `CheckpointConnection.openRemote` is not usable here — it requires `IModelApp.hubAccess` and contacts the hub for a file already on disk. `--itwin-platform` changes both, below.

### Authorization

None is checked, and none needs disabling. The backend never validates the token: it passes whatever arrives in the Authorization header straight through, and a locally opened iModel ignores it because `IModelDb.refreshContainerForRpc` is an empty method except on cloud checkpoints. Verified: `getElementProps` returns element data over HTTP with no Authorization header at all.

The server binds `127.0.0.1` only.

### Process lifecycle

The server runs in its own detached process with an IPC channel. It reports back over that channel once it is listening, so the parent prints the real port and exits rather than racing a poll loop. Details are recorded in `serve-backend.json` in the cache directory, with output going to `serve-backend.log` beside it.

`--stop` will not kill a process just because the recorded pid exists — a recycled pid would belong to something unrelated. It confirms the recorded port still answers `GET /imodels` first, and otherwise clears the record and reports it as stale.

Shutting down closes every iModel the server opened. An iModel left open outlives the server that opened it, and the next server would find the key already taken.

## Serving a standard iTwin.js web app

With `--itwin-platform`, a web app built for the iTwin Platform — its sign-in, the `ITwinGrid` / `IModelGrid` picker and `web-viewer-react`'s viewer — can be pointed at this server instead of Bentley's services, and opens the cached iModels with no account and no download. The app is given three URLs:

| URL | Answers as |
|---|---|
| `<server>/ims` | IMS: an OpenID Connect sign-in |
| `<server>/api` | the iTwin Platform API |
| `<server>` | the RPC backend |

**The sign-in** (`src/serve/local-sign-in.ts`) answers the authorization code flow with PKCE as `oidc-client-ts` drives it: the discovery document, `connect/authorize` (signs in at once, `prompt=none` included, and redirects back with a code), `connect/token` (a code once, the verifier checked), `connect/endsession`, `connect/userinfo` and an empty jwks. Tokens are unsigned (`alg: none`) and checked by nothing. It redirects only to a loopback address or the `--app-origin`.

**The API** (`src/serve/itwin-platform.ts`), in the real API's shapes:

| Endpoint | From the cache |
|---|---|
| `GET /itwins`, `/itwins/{id}` | the iTwins of the iModels in `imodels` that have a cached file. The cache keeps no iTwin names, so the id is the name |
| `GET /imodels?iTwinId=`, `/imodels/{id}` | those iModels, with `$search`, `$orderBy=name`, `$skip`, `$top` |
| `GET /imodels/{id}/changesets`, `/changesets/{idOrIndex}` | one changeset per cached file (briefcase or checkpoint), read from the file's `be_Local`; `$orderBy=index desc` and `$top=1` give the latest |
| `GET /imodels/{id}/namedversions` | always empty, so a viewer opens the latest changeset |
| `GET /imodels/{id}/thumbnail` | a plain placeholder PNG |
| `GET /itwins/favorites`, `/imodels/favorites`, `/recents` | always empty |

"Latest" is the cached file at the highest changeset. A checkpoint is preferred to a briefcase at the same changeset.

**Opening.** `IModelReadRpcInterface.getConnectionProps` looks for a `SnapshotDb` open under `CheckpointManager.getKey`, `<iModelId>:<changesetId>`, before it downloads anything (`RpcBriefcaseUtility.open`). A middleware ahead of the RPC routes reads the iModel and changeset from the request's path, as `BentleyCloudRpcProtocol.inflateToken` does, and opens the cached file read-only as a `SnapshotDb` under that key — a briefcase file too. A changeset the cache has no file of is refused with a 404, since the standard path would download it. Files the native library makes beside an open iModel, such as the tile cache, go to the system's temporary directory (`tempFileBase`), not into the cache.

## RPC Interfaces

Register IModelReadRPCInterface, IModelTileRpcInterface, ECSchemaRpcInterface and PresentationRpcInterface.

`IModelHost.startup` already registers the read, tile, snapshot and dev-tools implementations, so only `ECSchemaRpcImpl.register()` is called explicitly. Presentation is started once per process with `Presentation.initialize`, its hierarchy cache in memory: the default is a file beside each iModel, in the cache.

Routes follow the standard cloud RPC protocol: the POST catch-all for operations, `GET /imodel/...` for tile content, and `/v3/swagger.json`. Both catch-alls are regular expressions rather than `"*"`, which Express 5 rejects.
