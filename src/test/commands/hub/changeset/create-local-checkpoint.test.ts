import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BriefcaseDb, BriefcaseManager, PhysicalModel, PhysicalObject, SnapshotDb, SpatialCategory,
} from "@itwin/core-backend";
import { BriefcaseIdValue, Code, IModel, SubCategoryAppearance, type PhysicalElementProps } from "@itwin/core-common";
import { _nativeDb } from "@itwin/core-backend/lib/cjs/internal/Symbols.js";
import { closeCacheDb, getCacheDb } from "../../../../cache/cache-db";
import { recordChangesetFile, upsertChangesetMetadata } from "../../../../cache/changesets";
import { findBase, runCreateLocalCheckpoint } from "../../../../commands/hub/changeset/create-local-checkpoint";
import { HubMockFixture } from "../../../hub-mock-fixture";
import { testTempDir } from "../../../temp-workspace";

const fixture = new HubMockFixture();

let imodelId: string;
let baseFile: string;
let indexes: number[];

beforeAll(async () => {
  await fixture.startup("create-local-checkpoint");

  const briefcase = await fixture.createBriefcase("checkpoint-timeline");
  imodelId = briefcase.iModelId;
  baseFile = join(testTempDir("cp-base"), "at-zero.bim");
  copyFileSync(briefcase.fileName, baseFile);

  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, "cat", new SubCategoryAppearance());
  const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, "model");
  db.saveChanges();
  await db.pushChanges({ accessToken: "test-token", description: "model and category" });
  for (let i = 0; i < 2; i++) {
    db.elements.insertElement({
      classFullName: PhysicalObject.classFullName, model: modelId, category: categoryId,
      code: Code.createEmpty(), placement: { origin: [i, 0, 0], angles: {} },
    } as PhysicalElementProps);
    db.saveChanges();
    await db.pushChanges({ accessToken: "test-token", description: `element ${i}` });
  }
  db.close();

  const changesets = await BriefcaseManager.downloadChangesets({
    iModelId: imodelId, targetDir: BriefcaseManager.getChangeSetsPath(imodelId),
  });
  upsertChangesetMetadata(imodelId, changesets.map((c) => ({
    index: c.index, id: c.id, parentId: c.parentId, description: c.description,
    briefcaseId: c.briefcaseId, fileSize: c.size ?? statSync(c.pathname).size,
    containingChanges: c.changesType,
  })));
  for (const changeset of changesets)
    recordChangesetFile(imodelId, changeset.index, changeset.pathname);
  indexes = changesets.map((c) => c.index);
}, 120_000);

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

function outputPath(name: string): string {
  return join(testTempDir(name), `${name}.bim`);
}

describe("imod hub changeset create-local-checkpoint", () => {
  it("builds a checkpoint at a changeset from an earlier file", async () => {
    const filePath = outputPath("built");

    const result = await runCreateLocalCheckpoint({
      imodelId, changesetIndex: indexes[1], basePath: baseFile, outputPath: filePath,
    });

    expect(result.changesetIndex).toBe(indexes[1]);
    expect(result.applied).toBe(2);
    expect(existsSync(filePath)).toBe(true);

    const db = SnapshotDb.openFile(filePath, { key: "built" });
    try {
      expect(db.changeset.index).toBe(indexes[1]);
      // The changesets really were applied: the elements they inserted are there.
      expect(db.withPreparedStatement(
        "SELECT COUNT(*) FROM bis.PhysicalElement",
        (s) => { s.step(); return s.getValue(0).getInteger(); },
      )).toBe(1);
    } finally {
      db.close();
    }
  });

  it("makes a checkpoint, not a briefcase: the briefcase id is unassigned", async () => {
    const filePath = outputPath("unassigned");

    await runCreateLocalCheckpoint({
      imodelId, changesetIndex: indexes[0], basePath: baseFile, outputPath: filePath,
    });

    const db = SnapshotDb.openFile(filePath, { key: "unassigned" });
    try {
      expect(db[_nativeDb].getBriefcaseId()).toBe(BriefcaseIdValue.Unassigned);
      expect(db[_nativeDb].hasPendingTxns()).toBe(false);
    } finally {
      db.close();
    }
  });

  it("records the checkpoint in the cache so other commands can find it", async () => {
    const filePath = outputPath("recorded");

    await runCreateLocalCheckpoint({
      imodelId, changesetIndex: indexes[1], basePath: baseFile, outputPath: filePath,
    });

    const row = getCacheDb()
      .prepare("SELECT file_path FROM downloaded_checkpoints WHERE imodel_id = ? AND file_path = ?")
      .get(imodelId, filePath);
    expect(row).toEqual({ file_path: filePath });
  });

  it("accepts a changeset id as the target", async () => {
    const { listCachedChangesets } = await import("../../../../cache/changesets");
    const first = listCachedChangesets(imodelId)[0];
    const filePath = outputPath("by-id");

    const result = await runCreateLocalCheckpoint({
      imodelId, changesetId: first.id, basePath: baseFile, outputPath: filePath,
    });

    expect(result.changesetIndex).toBe(first.index);
  });

  it("picks the closest base at or before the target from the cache", async () => {
    // Other tests in this file record checkpoints of their own, and any of them would be a
    // legitimate candidate, so this one starts from a known set.
    const db = getCacheDb();
    db.prepare("DELETE FROM downloaded_checkpoints WHERE imodel_id = ?").run(imodelId);

    const later = outputPath("later-base");
    await runCreateLocalCheckpoint({
      imodelId, changesetIndex: indexes[1], basePath: baseFile, outputPath: later,
    });
    // An empty changeset id is the state before any changeset: index 0.
    db.prepare("INSERT OR REPLACE INTO downloaded_checkpoints (imodel_id, changeset_id, file_path) VALUES (?,?,?)")
      .run(imodelId, "", baseFile);

    // Targeting the first changeset, only the index 0 file is at or before it.
    expect(findBase(imodelId, indexes[0])?.filePath).toBe(baseFile);
    // Targeting the last, the checkpoint already sitting there is closer, so fewer changesets
    // have to be applied.
    expect(findBase(imodelId, indexes[1])).toEqual({ filePath: later, index: indexes[1] });
    expect(findBase("no-such-imodel", 1)).toBeUndefined();
  });

  it("refuses to overwrite a file that is already there", async () => {
    const filePath = outputPath("existing");
    await runCreateLocalCheckpoint({
      imodelId, changesetIndex: indexes[0], basePath: baseFile, outputPath: filePath,
    });

    await expect(runCreateLocalCheckpoint({
      imodelId, changesetIndex: indexes[0], basePath: baseFile, outputPath: filePath,
    })).rejects.toThrow(/already exists/);
  });

  it("leaves no half-built file behind when applying fails", async () => {
    const filePath = outputPath("failed");
    const { clearChangesetFile } = await import("../../../../cache/changesets");
    clearChangesetFile(imodelId, indexes[1]);
    try {
      await expect(runCreateLocalCheckpoint({
        imodelId, changesetIndex: indexes[1], basePath: baseFile, outputPath: filePath,
      })).rejects.toThrow(/not downloaded/);

      // A file at the wrong changeset would look valid to anything that found it later.
      expect(existsSync(filePath)).toBe(false);
    } finally {
      const { listCachedChangesets } = await import("../../../../cache/changesets");
      const dir = BriefcaseManager.getChangeSetsPath(imodelId);
      const cached = listCachedChangesets(imodelId, { start: indexes[1], end: indexes[1] })[0];
      recordChangesetFile(imodelId, indexes[1], join(dir, `${cached.id}.cs`));
    }
  });

  it("leaves no file behind when the base turns out not to be an iModel", async () => {
    // A different path out of the command than a failure part way through applying: the open
    // throws before any of that, and the copy still has to go.
    const filePath = outputPath("bad-base");
    const notAnIModel = join(testTempDir("junk"), "junk.bim");
    writeFileSync(notAnIModel, "this is not a database");

    await expect(runCreateLocalCheckpoint({
      imodelId, changesetIndex: indexes[0], basePath: notAnIModel, outputPath: filePath,
    })).rejects.toThrow(/not a database/i);

    expect(existsSync(filePath)).toBe(false);
  });

  it("requires a target changeset", async () => {
    await expect(runCreateLocalCheckpoint({ imodelId })).rejects.toThrow(/--changeset-id or --changeset-index/);
  });

  it("reports a target it has no metadata for", async () => {
    await expect(runCreateLocalCheckpoint({ imodelId, changesetIndex: 9999, basePath: baseFile }))
      .rejects.toThrow(/not in the cache/);
  });
});
