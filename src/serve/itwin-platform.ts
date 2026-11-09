import * as zlib from "node:zlib";
import express, { type Request, type Response, type Router } from "express";
import { getCacheDb } from "../cache/cache-db";
import { getCachedIModel, type CachedIModelDetails } from "../cache/imodels";
import { hasCachedFile, listCachedVersions, type CachedVersion } from "./cached-versions";
import { platformCors, type PlatformCorsOptions } from "./platform-cors";

/**
 * The part of the iTwin Platform API that an iTwin and iModel picker and a viewer's hub
 * access call, answered from imodulator's cache.
 *
 * Only what the cache can answer: the iTwins of its iModels, those iModels, and the
 * changesets it holds files for. "Latest" means the latest version in the cache, which is
 * what the backend can open. Named versions, favorites and recents are always empty.
 *
 * The shapes are the real API's, as `@itwin/imodels-client-management` and
 * `@itwin/imodel-browser-react` read them: a collection under its plural name with `_links`,
 * a single entity under its singular name, and errors as `{ error: { code, message } }`.
 * The Authorization header is not checked: like the RPC routes, this is reachable only from
 * this machine, and serves only what is already on it.
 */
export function itwinPlatformApi(cors: PlatformCorsOptions): Router {
  const router = express.Router();
  router.use(platformCors(cors));

  router.get("/itwins", (req, res) => {
    const subClass = stringParam(req, "subClass");
    // Every iTwin here is presented as a project; a request for any other kind finds none.
    const all = subClass && subClass !== "Project" && subClass !== "All" ? [] : listITwins();
    const search = stringParam(req, "$search")?.toLowerCase();
    const found = search ? all.filter((iTwin) => iTwin.displayName.toLowerCase().includes(search) || iTwin.number.toLowerCase().includes(search)) : all;
    sendPage(req, res, "iTwins", found);
  });
  // Favorites and recents are personal lists the cache does not keep.
  router.get(["/itwins/favorites", "/itwins/recents"], (req, res) => sendPage(req, res, "iTwins", []));
  router.get("/itwins/:iTwinId", (req, res) => {
    const iTwin = listITwins().find((candidate) => candidate.id === req.params.iTwinId);
    if (!iTwin)
      return notFound(res, "iTwinNotFound", `The cache holds no iModel of iTwin ${req.params.iTwinId}.`);
    res.json({ iTwin });
  });

  router.get("/imodels", (req, res) => {
    const iTwinId = stringParam(req, "iTwinId");
    if (!iTwinId)
      return res.status(422).json({ error: { code: "InvalidiModelsRequest", message: "Supply the iTwin as `iTwinId`." } });
    const search = stringParam(req, "$search")?.toLowerCase();
    let found = listIModels(iTwinId).map((details) => toIModel(req, details));
    if (search)
      found = found.filter((iModel) => iModel.name.toLowerCase().includes(search) || iModel.displayName.toLowerCase().includes(search));
    const [property, direction] = (stringParam(req, "$orderBy") ?? "name asc").split(" ");
    if (property === "name")
      found.sort((a, b) => a.name.localeCompare(b.name) * (direction === "desc" ? -1 : 1));
    sendPage(req, res, "iModels", found);
  });
  router.get(["/imodels/favorites", "/imodels/recents"], (req, res) => sendPage(req, res, "iModels", []));
  router.get("/imodels/:iModelId", (req, res) => {
    const details = cachedIModel(req.params.iModelId);
    if (!details)
      return notFound(res, "iModelNotFound", `The cache holds no iModel ${req.params.iModelId}.`);
    res.json({ iModel: toIModel(req, details) });
  });
  // A plain placeholder: the cache keeps no thumbnails. Served so a picker given this URL as
  // the thumbnail shows an image rather than a broken one.
  router.get("/imodels/:iModelId/thumbnail", (_req, res) => {
    res.type("png").send(PLACEHOLDER_THUMBNAIL);
  });

  router.get("/imodels/:iModelId/changesets", (req, res) => {
    const { iModelId } = req.params;
    if (!cachedIModel(iModelId))
      return notFound(res, "iModelNotFound", `The cache holds no iModel ${iModelId}.`);
    let versions = listCachedVersions(iModelId);
    const afterIndex = numberParam(req, "afterIndex");
    const lastIndex = numberParam(req, "lastIndex");
    if (afterIndex !== undefined)
      versions = versions.filter((version) => (version.changeset.index ?? 0) > afterIndex);
    if (lastIndex !== undefined)
      versions = versions.filter((version) => (version.changeset.index ?? 0) <= lastIndex);
    // `$orderBy=index desc` with `$top=1` is how the hub access asks for the latest changeset.
    if (/^index desc$/i.test(stringParam(req, "$orderBy") ?? ""))
      versions = [...versions].reverse();
    sendPage(req, res, "changesets", versions.map((version) => toChangeset(req, version)));
  });
  router.get("/imodels/:iModelId/changesets/:idOrIndex", (req, res) => {
    const { iModelId, idOrIndex } = req.params;
    const version = listCachedVersions(iModelId).find((candidate) =>
      /^\d+$/.test(idOrIndex) ? candidate.changeset.index === Number(idOrIndex) : candidate.changeset.id === idOrIndex);
    if (!version)
      return notFound(res, "ChangesetNotFound", `The cache holds no file of iModel ${iModelId} at changeset ${idOrIndex}.`);
    res.json({ changeset: toChangeset(req, version) });
  });
  // The cache does not know the iModel's named versions. A viewer asking for the latest one
  // finds none and opens the latest changeset instead, which is what the cache serves.
  router.get("/imodels/:iModelId/namedversions", (req, res) => sendPage(req, res, "namedVersions", []));

  router.use((req, res) => notFound(res, "NotFound", `imodulator does not answer ${req.method} ${req.baseUrl}${req.path}.`));
  return router;
}

interface ITwin {
  id: string;
  class: "Endeavor";
  subClass: "Project";
  type: null;
  number: string;
  displayName: string;
  status: "Active";
  dataCenterLocation: string;
  geographicLocation: null;
  ianaTimeZone: null;
  parentId: null;
  iTwinAccountId: null;
  createdDateTime: null;
  createdBy: null;
}

/**
 * The iTwins of the cached iModels. The cache does not record an iTwin's name, so its id
 * stands in for it.
 */
function listITwins(): ITwin[] {
  const rows = getCacheDb().prepare("SELECT DISTINCT itwin_id FROM imodels ORDER BY itwin_id").all() as { itwin_id: string }[];
  return rows
    .filter((row) => listIModels(row.itwin_id).length > 0)
    .map((row) => ({
      id: row.itwin_id,
      class: "Endeavor",
      subClass: "Project",
      type: null,
      number: row.itwin_id,
      displayName: row.itwin_id,
      status: "Active",
      dataCenterLocation: "Local",
      geographicLocation: null,
      ianaTimeZone: null,
      parentId: null,
      iTwinAccountId: null,
      createdDateTime: null,
      createdBy: null,
    }));
}

/** The iModels of an iTwin the cache can serve: those it knows by name and holds a file of. */
function listIModels(iTwinId: string): CachedIModelDetails[] {
  const rows = getCacheDb().prepare("SELECT imodel_id FROM imodels WHERE itwin_id = ? ORDER BY name").all(iTwinId) as { imodel_id: string }[];
  return rows.map((row) => cachedIModel(row.imodel_id)).filter((details): details is CachedIModelDetails => details !== undefined);
}

function cachedIModel(iModelId: string): CachedIModelDetails | undefined {
  const details = getCachedIModel(iModelId);
  return details && hasCachedFile(iModelId) ? details : undefined;
}

function toIModel(req: Request, details: CachedIModelDetails) {
  const self = `${apiBase(req)}/imodels/${details.imodelId}`;
  return {
    id: details.imodelId,
    displayName: details.displayName ?? details.name,
    name: details.name,
    description: details.description ?? null,
    state: "initialized",
    createdDateTime: null,
    iTwinId: details.itwinId,
    isSecured: false,
    extent: null,
    dataCenterLocation: "Local",
    lastChangesetPushDateTime: latestPushDateTime(details.imodelId),
    _links: {
      creator: null,
      changesets: { href: `${self}/changesets` },
      namedVersions: { href: `${self}/namedversions` },
      upload: null,
      download: null,
      lock: null,
    },
  };
}

function latestPushDateTime(iModelId: string): string | null {
  const row = getCacheDb()
    .prepare("SELECT MAX(push_date_time) AS pushed FROM changesets WHERE imodel_id = ?")
    .get(iModelId) as { pushed: string | null } | undefined;
  return row?.pushed ?? null;
}

interface ChangesetRow {
  description: string | null;
  parent_id: string | null;
  push_date_time: string | null;
  briefcase_id: number | null;
  file_size: number;
  containing_changes: number | null;
  creator_id: string | null;
}

/** A cached version as a changeset, with what the cache's changesets table adds when it has the row. */
function toChangeset(req: Request, version: CachedVersion) {
  const { iModelId, changeset } = version;
  const row = getCacheDb()
    .prepare("SELECT description, parent_id, push_date_time, briefcase_id, file_size, containing_changes, creator_id FROM changesets WHERE imodel_id = ? AND changeset_id = ?")
    .get(iModelId, changeset.id) as ChangesetRow | undefined;
  return {
    id: changeset.id,
    displayName: String(changeset.index ?? 0),
    application: null,
    synchronizationInfo: null,
    description: row?.description ?? null,
    index: changeset.index ?? 0,
    parentId: row?.parent_id ?? null,
    creatorId: row?.creator_id ?? null,
    pushDateTime: row?.push_date_time ?? null,
    state: "fileUploaded",
    containingChanges: row?.containing_changes ?? 0,
    fileSize: row?.file_size ?? 0,
    briefcaseId: row?.briefcase_id ?? 0,
    groupId: null,
    _links: {
      self: { href: `${apiBase(req)}/imodels/${iModelId}/changesets/${changeset.id}` },
      download: null,
      namedVersion: null,
      currentOrPrecedingCheckpoint: null,
      creator: null,
    },
  };
}

/**
 * A page of a collection, as `$skip` and `$top` ask. There is never a next page link: a
 * caller asking for more simply asks again with a larger `$skip`.
 */
function sendPage<T>(req: Request, res: Response, name: string, items: T[]): void {
  const skip = numberParam(req, "$skip") ?? 0;
  const top = numberParam(req, "$top") ?? 100;
  res.json({
    [name]: items.slice(skip, skip + top),
    _links: { self: { href: `${apiBase(req)}${req.path}` }, prev: null, next: null },
  });
}

function notFound(res: Response, code: string, message: string): void {
  res.status(404).json({ error: { code, message } });
}

/** The API's own base URL, as the caller reached it, for the links in its answers. */
function apiBase(req: Request): string {
  return `${req.protocol}://${req.get("host")}${req.baseUrl}`;
}

function stringParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberParam(req: Request, name: string): number | undefined {
  const value = stringParam(req, name);
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** A small solid light-grey PNG, built once. */
const PLACEHOLDER_THUMBNAIL = solidPng(160, 100, [0xe8, 0xea, 0xed]);

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per sample
  header[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3])]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
