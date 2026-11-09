import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { IModelDb, SQLiteDb } from "@itwin/core-backend";
import { OpenMode } from "@itwin/core-bentley";
import { IModelVersion } from "@itwin/core-common";
import { BackendIModelsAccess } from "@itwin/imodels-access-backend";
import { IModelsClient } from "@itwin/imodels-client-authoring";
import { ITWIN_API_PATH, SIGN_IN_PATH, startBackendServer, type RunningServer } from "../../../serve/backend-server";
import { isAllowedRedirect } from "../../../serve/local-sign-in";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { upsertIModel } from "../../../cache/imodels";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";
import { testCacheDir } from "../../temp-workspace";

const fixture = new HubMockFixture();
let briefcase: TestBriefcase;
/** A checkpoint of the same iModel at a later changeset, made by rewriting a copy's local properties. */
const LATER = { id: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00", index: 7 };
let laterFile: string;
let server: RunningServer | undefined;

beforeAll(async () => {
  await fixture.startup("serve-itwin-platform");
  briefcase = await fixture.createBriefcase("platform");

  const dir = join(testCacheDir(), "imodels", briefcase.iModelId, "checkpoints");
  mkdirSync(dir, { recursive: true });
  laterFile = join(dir, `${briefcase.iModelId}_${LATER.id}.bim`);
  copyFileSync(briefcase.fileName, laterFile);
  const db = new SQLiteDb();
  db.openDb(laterFile, OpenMode.ReadWrite);
  db.withSqliteStatement("INSERT OR REPLACE INTO be_Local (name, val) VALUES ('parentChangeset', ?)", (stmt) => {
    stmt.bindString(1, JSON.stringify(LATER));
    stmt.step();
  });
  db.withSqliteStatement("INSERT OR REPLACE INTO be_Local (name, val) VALUES ('ParentChangeSetId', ?)", (stmt) => {
    stmt.bindString(1, LATER.id);
    stmt.step();
  });
  db.saveChanges();
  db.closeDb();

  const cache = getCacheDb();
  cache.prepare("INSERT OR REPLACE INTO downloaded_briefcases (imodel_id, briefcase_id, file_path) VALUES (?, ?, ?)")
    .run(briefcase.iModelId, briefcase.briefcaseId, briefcase.fileName);
  cache.prepare("INSERT OR REPLACE INTO downloaded_checkpoints (imodel_id, changeset_id, file_path) VALUES (?, ?, ?)")
    .run(briefcase.iModelId, LATER.id, laterFile);
  upsertIModel({ imodelId: briefcase.iModelId, itwinId: briefcase.iTwinId, name: "Platform test", description: "for the picker" });
  // Known by name but with no file: not offered.
  upsertIModel({ imodelId: "00000000-0000-0000-0000-00000000dead", itwinId: briefcase.iTwinId, name: "Gone" });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

/** What the RPC protocol requires of every request. */
const RPC_HEADERS = { "X-Correlation-Id": "test-activity", "X-Session-Id": "test-session", "X-Application-Id": "test", "X-Application-Version": "1.0" };

async function start(appOrigin?: string): Promise<RunningServer> {
  server = await startBackendServer({ port: 0, itwinPlatform: true, appOrigin });
  return server;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(url, { headers: { Authorization: "Bearer anything", ...headers } });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

describe("imod serve backend --itwin-platform: the iTwin Platform API", () => {
  it("is not served without the option", async () => {
    server = await startBackendServer({ port: 0 });
    const response = await fetch(`${server.url}${ITWIN_API_PATH}/itwins`);
    expect(response.headers.get("content-type") ?? "").not.toMatch(/json/);
    expect(server.itwinPlatform).toBeUndefined();
  });

  it("lists the cached iModels' iTwins and iModels as the picker reads them", async () => {
    const { url, itwinPlatform } = await start();
    expect(itwinPlatform).toEqual({ signInUrl: `${url}${SIGN_IN_PATH}`, apiUrl: `${url}${ITWIN_API_PATH}` });

    const iTwins = await getJson(`${url}/api/itwins?subClass=Project&$skip=0&$top=100`);
    expect(iTwins.body.iTwins).toEqual([expect.objectContaining({ id: briefcase.iTwinId, displayName: briefcase.iTwinId, subClass: "Project" })]);
    expect(iTwins.body._links.next).toBeNull();

    const iModels = await getJson(`${url}/api/imodels?iTwinId=${briefcase.iTwinId}&$top=100`);
    expect(iModels.body.iModels).toEqual([
      expect.objectContaining({ id: briefcase.iModelId, name: "Platform test", displayName: "Platform test", iTwinId: briefcase.iTwinId, state: "initialized" }),
    ]);

    const single = await getJson(`${url}/api/imodels/${briefcase.iModelId}`);
    expect(single.body.iModel.id).toBe(briefcase.iModelId);
    expect((await getJson(`${url}/api/itwins/favorites?subClass=Project`)).body.iTwins).toEqual([]);
    expect((await getJson(`${url}/api/imodels/00000000-0000-0000-0000-00000000dead`)).status).toBe(404);
  });

  it("answers the iModels client the way a viewer's hub access calls it", async () => {
    const { url } = await start();
    const hubAccess = new BackendIModelsAccess(new IModelsClient({ api: { baseUrl: `${url}/api/imodels` } }));
    const arg = { iModelId: briefcase.iModelId, accessToken: "Bearer anything" };

    // Latest is the latest the cache holds a file for; the briefcase is at the first version.
    expect(await hubAccess.getChangesetFromVersion({ ...arg, version: IModelVersion.latest() })).toMatchObject(LATER);
    expect(await hubAccess.getChangesetFromVersion({ ...arg, version: IModelVersion.asOfChangeSet(LATER.id) })).toMatchObject(LATER);
    // No named versions: a viewer then falls back to the latest changeset.
    await expect(hubAccess.getChangesetFromNamedVersion(arg)).rejects.toThrow(/named version/i);

    const all = await getJson(`${url}/api/imodels/${briefcase.iModelId}/changesets`);
    expect(all.body.changesets.map((changeset: { id: string; index: number }) => [changeset.id, changeset.index])).toEqual([["", 0], [LATER.id, LATER.index]]);
  });

  it("opens a cached file under the checkpoint key on the first connect, without downloading", async () => {
    const { url } = await start();
    const connect = async (changeset: string) => fetch(
      `${url}/imodulator/v1.0/mode/1/context/${briefcase.iTwinId}/imodel/${briefcase.iModelId}/changeset/${changeset}/IModelReadRpcInterface-3.8.0-getConnectionProps`,
      { method: "POST", headers: { "Content-Type": "text/plain", ...RPC_HEADERS }, body: JSON.stringify([{ iTwinId: briefcase.iTwinId, iModelId: briefcase.iModelId, changeset: { id: changeset === "0" ? "" : changeset } }]) },
    );

    const later = await connect(LATER.id);
    expect(later.status).toBe(200);
    expect((await later.json()).key).toBe(`${briefcase.iModelId}:${LATER.id}`);
    // The file served is the cached one: had the standard path downloaded a checkpoint, the
    // key would name a file in the host's own checkpoint folder instead.
    expect(IModelDb.tryFindByKey(`${briefcase.iModelId}:${LATER.id}`)?.pathName).toContain(`${LATER.id}.bim`);

    // The briefcase, at the first version ("0" in the route), opens as a snapshot too.
    const first = await connect("0");
    expect(first.status).toBe(200);
    expect(IModelDb.tryFindByKey(`${briefcase.iModelId}:`)?.isSnapshot).toBe(true);

    // A version the cache has no file of is refused rather than downloaded.
    const missing = await connect("1234567890abcdef1234567890abcdef12345678");
    expect(missing.status).toBe(404);
    // With CORS headers, so a browser sees the refusal rather than a CORS failure.
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("opens on a connect the way a web viewer sends it: a GET under the default route prefix", async () => {
    const { url } = await start();
    const token = { iTwinId: briefcase.iTwinId, iModelId: briefcase.iModelId, changeset: { id: LATER.id, index: LATER.index } };
    const parameters = Buffer.from(JSON.stringify([token])).toString("base64");
    // web-viewer-react's default prefix is "imodel/rpc": "imodel" appears twice in the route.
    const response = await fetch(
      `${url}/imodel/rpc/v5/mode/1/context/${briefcase.iTwinId}/imodel/${briefcase.iModelId}/changeset/${LATER.id}/IModelReadRpcInterface-3.8.0-getConnectionProps?parameters=${parameters}`,
      { headers: RPC_HEADERS },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).key).toBe(`${briefcase.iModelId}:${LATER.id}`);
  });

  it("allows the iModels client's headers from any origin, or only the app's when one is given", async () => {
    const preflight = (url: string, origin: string) => fetch(`${url}/api/imodels/${briefcase.iModelId}/changesets`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,prefer" },
    });

    const open = await start();
    const any = await preflight(open.url, "http://localhost:5173");
    expect(any.status).toBe(204);
    expect(any.headers.get("access-control-allow-origin")).toBe("*");
    expect(any.headers.get("access-control-allow-headers")).toMatch(/Prefer/);
    await open.close();

    const limited = await start("http://localhost:3000");
    expect((await preflight(limited.url, "http://localhost:3000")).headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect((await preflight(limited.url, "http://elsewhere.example")).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves a thumbnail image", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/api/imodels/${briefcase.iModelId}/thumbnail`);
    expect(response.headers.get("content-type")).toMatch(/image\/png/);
    expect(Buffer.from(await response.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("imod serve backend --itwin-platform: the local sign-in", () => {
  const app = "http://localhost:3000";
  const verifier = "a-long-enough-code-verifier-for-the-test-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  async function authorize(url: string, params: Record<string, string>): Promise<URL> {
    const query = new URLSearchParams({
      client_id: "any-client",
      redirect_uri: `${app}/signin-callback`,
      response_type: "code",
      scope: "itwin-platform",
      state: "the-state",
      nonce: "the-nonce",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...params,
    });
    const response = await fetch(`${url}/ims/connect/authorize?${query}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location")!);
  }

  const exchange = (url: string, code: string, codeVerifier = verifier) => fetch(`${url}/ims/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: codeVerifier, client_id: "any-client", redirect_uri: `${app}/signin-callback` }),
  });

  it("publishes its endpoints under the URL the app was given", async () => {
    const { url } = await start();
    const { body } = await getJson(`${url}/ims/.well-known/openid-configuration`);
    expect(body.issuer).toBe(`${url}/ims`);
    expect(body.authorization_endpoint).toBe(`${url}/ims/connect/authorize`);
    expect(body.token_endpoint).toBe(`${url}/ims/connect/token`);
    expect(body.end_session_endpoint).toBe(`${url}/ims/connect/endsession`);
  });

  it("signs in at once, silently too, and exchanges the code once with PKCE", async () => {
    const { url } = await start();
    for (const prompt of [undefined, "none"]) {
      const back = await authorize(url, prompt ? { prompt } : {});
      expect(back.origin + back.pathname).toBe(`${app}/signin-callback`);
      expect(back.searchParams.get("state")).toBe("the-state");
      const code = back.searchParams.get("code")!;

      const response = await exchange(url, code);
      expect(response.status).toBe(200);
      const tokens = await response.json();
      expect(tokens.token_type).toBe("Bearer");
      expect(tokens.expires_in).toBeGreaterThan(60);
      const idToken = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
      expect(idToken).toMatchObject({ iss: `${url}/ims`, aud: "any-client", nonce: "the-nonce", sub: "local-user" });

      expect((await exchange(url, code)).status).toBe(400);
    }
  });

  it("refuses a code_verifier that does not match", async () => {
    const { url } = await start();
    const code = (await authorize(url, {})).searchParams.get("code")!;
    const response = await exchange(url, code, "not-the-verifier");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_grant");
  });

  it("sends a sign-in back only to this machine or the app origin", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/ims/connect/authorize?client_id=c&response_type=code&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`, { redirect: "manual" });
    expect(response.status).toBe(400);

    expect(isAllowedRedirect("http://127.0.0.1:5173/cb", undefined)).toBe(true);
    expect(isAllowedRedirect("http://[::1]:5173/cb", undefined)).toBe(true);
    expect(isAllowedRedirect("https://app.example/cb", "https://app.example")).toBe(true);
    expect(isAllowedRedirect("https://app.example.evil/cb", "https://app.example")).toBe(false);
    expect(isAllowedRedirect("javascript:alert(1)", undefined)).toBe(false);
  });

  it("signs out back to the app", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/ims/connect/endsession?post_logout_redirect_uri=${encodeURIComponent(app)}&state=s`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${app}/?state=s`);
  });
});
