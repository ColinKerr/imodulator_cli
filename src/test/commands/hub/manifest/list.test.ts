import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveManifestPath,
  runListManifest,
  summarize,
  toDatabaseTable,
} from "../../../../commands/hub/manifest/list";
import {
  MANIFEST_DB_HEADER_BYTES,
  MANIFEST_DB_NAME_BYTES,
  MANIFEST_HEADER_BYTES,
  MANIFEST_VERSION,
  type ManifestInfo,
} from "../../../../manifest/manifest-file";

const IMODEL = "55555555-5555-5555-5555-555555555555";

let cacheDir: string;
let previousCacheDir: string | undefined;

/** A minimal version 4 manifest holding one database. */
function manifestBytes(name: string, blockCount: number, deleted = false): Buffer {
  const data = Buffer.alloc(MANIFEST_HEADER_BYTES + MANIFEST_DB_HEADER_BYTES);
  data.writeUInt32BE(MANIFEST_VERSION, 0);
  data.writeUInt32BE(4 * 1024 * 1024, 4);
  data.writeUInt32BE(1, 8);
  data.writeUInt32BE(0, 12);
  data.writeUInt32BE(16, 16);
  data.writeUInt32BE(1, 20);
  data.writeUInt32BE(1, MANIFEST_HEADER_BYTES + 0);
  data.writeUInt32BE(deleted ? (blockCount | 0x80000000) >>> 0 : blockCount, MANIFEST_HEADER_BYTES + 16);
  data.write(name, MANIFEST_HEADER_BYTES + 24, MANIFEST_DB_NAME_BYTES, "utf8");
  return data;
}

beforeAll(() => {
  previousCacheDir = process.env.IMOD_CACHE_DIR;
  cacheDir = mkdtempSync(join(tmpdir(), "imod-manifest-list-"));
  process.env.IMOD_CACHE_DIR = cacheDir;
});

afterAll(() => {
  if (previousCacheDir === undefined)
    delete process.env.IMOD_CACHE_DIR;
  else
    process.env.IMOD_CACHE_DIR = previousCacheDir;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("resolveManifestPath", () => {
  it("prefers an explicit --manifest-path", () => {
    const filePath = join(cacheDir, "explicit.bcv");
    writeFileSync(filePath, manifestBytes("a.bim", 1));
    expect(resolveManifestPath({ manifestPath: filePath, imodelId: IMODEL })).toBe(filePath);
  });

  it("throws when --manifest-path does not exist", () => {
    expect(() => resolveManifestPath({ manifestPath: "/no/such/manifest.bcv" }))
      .toThrow(/Manifest file not found/);
  });

  it("points at the download command when nothing is cached for the iModel", () => {
    expect(() => resolveManifestPath({ imodelId: IMODEL }))
      .toThrow(/imod hub manifest download/);
  });

  it("throws when given neither option", () => {
    expect(() => resolveManifestPath({})).toThrow(/Provide --imodel-id, or --manifest-path/);
  });

  it("finds the manifest cached for the iModel", () => {
    const dir = join(cacheDir, "imodels", IMODEL);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "manifest.bcv");
    writeFileSync(filePath, manifestBytes("cached.bim", 3));
    expect(resolveManifestPath({ imodelId: IMODEL })).toBe(filePath);
  });
});

describe("runListManifest", () => {
  it("parses the manifest it resolved", () => {
    const filePath = join(cacheDir, "run.bcv");
    writeFileSync(filePath, manifestBytes("run.bim", 9));
    const result = runListManifest({ manifestPath: filePath });
    expect(result.filePath).toBe(filePath);
    expect(result.manifest.databases[0]).toMatchObject({ name: "run.bim", blockCount: 9 });
  });
});

describe("toDatabaseTable", () => {
  const manifest: ManifestInfo = {
    version: 4,
    blockSize: 4 * 1024 * 1024,
    nameSize: 16,
    maxDbId: 2,
    deleteEntryCount: 5,
    databases: [
      { id: 1, parentId: 0, version: 1, blockCount: 10, blockArrayOffset: 0, blockArrayEntries: 10, name: "live.bim", deleted: false },
      { id: 2, parentId: 1, version: 2, blockCount: 4, blockArrayOffset: 64, blockArrayEntries: 2, name: "gone.bim", deleted: true },
    ],
  };

  it("marks deleted databases instead of hiding them", () => {
    const table = toDatabaseTable(manifest);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual(["live.bim", 1, "", 1, 10, ""]);
    expect(table.rows[1]).toEqual(["gone.bim", 2, 1, 2, 4, "deleted"]);
  });

  it("summarises the header", () => {
    expect(summarize(manifest)).toContain("manifest version 4");
    expect(summarize(manifest)).toContain("2 database(s)");
    expect(summarize(manifest)).toContain("5 block(s) on the delete list");
  });
});
