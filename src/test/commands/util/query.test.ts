import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BriefcaseDb, PhysicalModel, SpatialCategory } from "@itwin/core-backend";
import { Code, IModel, SubCategoryAppearance, type QueryStats } from "@itwin/core-common";
import { formatQueryStats, runQuery } from "../../../commands/util/query";
import { closeCacheDb } from "../../../cache/cache-db";
import { HubMockFixture } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();
let cacheDir: string;
let tempDir: string;
let imodelPath: string;

beforeAll(async () => {
  // Isolate the cache (and IModelHost workspace) in a temp dir so the test does not touch
  // the real ~/.imod/cache or collide with other test files.
  cacheDir = mkdtempSync(join(tmpdir(), "imod-query-cache-"));
  process.env.IMOD_CACHE_DIR = cacheDir;
  await fixture.startup("query");
  tempDir = mkdtempSync(join(tmpdir(), "imod-query-test-"));

  // Seed a briefcase with a few elements to query against.
  const briefcase = await fixture.createBriefcase("query");
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  try {
    SpatialCategory.insert(db, IModel.dictionaryId, "query-cat", new SubCategoryAppearance());
    PhysicalModel.insert(db, IModel.rootSubjectId, "query-model");
    db.saveChanges();
  } finally {
    db.close();
  }
  imodelPath = briefcase.fileName;
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

function writeQuery(name: string, ecsql: string): string {
  const queryPath = join(tempDir, `${name}.sql`);
  writeFileSync(queryPath, ecsql, "utf8");
  return queryPath;
}

describe("imod util query", () => {
  it("writes results as CSV and returns query statistics", async () => {
    const queryPath = writeQuery("all", "SELECT ECInstanceId, ECClassId FROM bis.Element");
    const resultsPath = join(tempDir, "all.csv");

    const stats = await runQuery({ imodelPath, queryPath, resultsPath });

    const lines = readFileSync(resultsPath, "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe("ECInstanceId,ECClassId");
    const dataRows = lines.length - 1;
    expect(dataRows).toBeGreaterThan(0);

    // Stats should reflect the rows the backend produced.
    expect(stats.backendRowsReturned).toBe(dataRows);
    expect(stats.backendCpuTime).toBeGreaterThanOrEqual(0);
    expect(stats.totalTime).toBeGreaterThanOrEqual(0);
    expect(stats.retryCount).toBeGreaterThanOrEqual(0);
  });

  it("formatQueryStats renders the key metrics for the console", () => {
    const stats: QueryStats = {
      backendCpuTime: 5019,
      backendTotalTime: 5,
      backendMemUsed: 97,
      backendRowsReturned: 6,
      totalTime: 6,
      retryCount: 0,
    };
    const text = formatQueryStats(stats);
    expect(text).toContain("Rows returned:      6");
    expect(text).toContain("Backend CPU time:   5.02 ms");
    expect(text).toContain("Memory used:        97 bytes");
    expect(text).toContain("Retries:            0");
  });

  it("throws when the iModel file does not exist", async () => {
    const queryPath = writeQuery("missing-imodel", "SELECT 1");
    await expect(
      runQuery({ imodelPath: "/no/such/imodel.bim", queryPath, resultsPath: join(tempDir, "x.csv") }),
    ).rejects.toThrow(/not found/);
  });

  it("throws when the query file is empty", async () => {
    const queryPath = writeQuery("empty", "   ");
    await expect(
      runQuery({ imodelPath, queryPath, resultsPath: join(tempDir, "empty.csv") }),
    ).rejects.toThrow(/empty/);
  });
});
