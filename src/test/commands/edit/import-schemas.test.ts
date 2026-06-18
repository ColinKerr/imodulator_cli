import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BriefcaseDb } from "@itwin/core-backend";
import { runImportSchemas } from "../../../commands/edit/import-schemas";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();
let cacheDir: string;
let schemaDir: string;

const SCHEMA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ECSchema schemaName="TestSchema" alias="ts" version="01.00.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.2">
  <ECSchemaReference name="BisCore" version="01.00.00" alias="bis"/>
  <ECEntityClass typeName="TestElement" modifier="None">
    <BaseClass>bis:PhysicalElement</BaseClass>
    <ECProperty propertyName="TestProp" typeName="string"/>
  </ECEntityClass>
</ECSchema>`;

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "imod-import-schemas-cache-"));
  process.env.IMOD_CACHE_DIR = cacheDir;
  await fixture.startup("import-schemas");

  schemaDir = mkdtempSync(join(tmpdir(), "imod-import-schemas-files-"));
  writeFileSync(join(schemaDir, "TestSchema.ecschema.xml"), SCHEMA_XML, "utf8");
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(schemaDir, { recursive: true, force: true });
});

async function registeredBriefcase(name: string): Promise<TestBriefcase> {
  const briefcase = await fixture.createBriefcase(name);
  getCacheDb()
    .prepare(
      "INSERT OR REPLACE INTO downloaded_briefcases (imodel_id, briefcase_id, file_path) VALUES (?, ?, ?)",
    )
    .run(briefcase.iModelId, briefcase.briefcaseId, briefcase.fileName);
  return briefcase;
}

describe("imod edit import-schemas", () => {
  it("imports schemas from a directory and leaves a pushable changeset", async () => {
    const briefcase = await registeredBriefcase("import");

    const files = await runImportSchemas({
      imodelId: briefcase.iModelId,
      briefcaseId: briefcase.briefcaseId,
      schemaPath: schemaDir,
    });
    expect(files).toHaveLength(1);

    const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
    try {
      expect(db.querySchemaVersion("TestSchema")).toBe("1.0.0");
      expect(db.txns.hasPendingTxns).toBe(true);
    } finally {
      db.close();
    }
  });

  it("accepts a single schema file path", async () => {
    const briefcase = await registeredBriefcase("import-file");

    const files = await runImportSchemas({
      imodelId: briefcase.iModelId,
      briefcaseId: briefcase.briefcaseId,
      schemaPath: join(schemaDir, "TestSchema.ecschema.xml"),
    });
    expect(files).toHaveLength(1);

    const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: true });
    try {
      expect(db.querySchemaVersion("TestSchema")).toBe("1.0.0");
    } finally {
      db.close();
    }
  });

  it("throws when the briefcase is not downloaded locally", async () => {
    await expect(
      runImportSchemas({ imodelId: "not-a-real-imodel", briefcaseId: 2, schemaPath: schemaDir }),
    ).rejects.toThrow(/not downloaded locally/);
  });

  it("throws when no schema files are found at the path", async () => {
    const empty = mkdtempSync(join(tmpdir(), "imod-import-schemas-empty-"));
    try {
      await expect(
        runImportSchemas({ imodelId: "x", briefcaseId: 2, schemaPath: empty }),
      ).rejects.toThrow(/No schema files/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
