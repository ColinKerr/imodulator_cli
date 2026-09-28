import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BriefcaseDb, BriefcaseManager, PhysicalModel, PhysicalObject, SnapshotDb, SpatialCategory,
} from "@itwin/core-backend";
import { Code, IModel, SubCategoryAppearance, type PhysicalElementProps } from "@itwin/core-common";
import { _nativeDb } from "@itwin/core-backend/lib/cjs/internal/Symbols.js";
import { closeCacheDb, getCacheDb } from "../../../../cache/cache-db";
import { recordChangesetFile, upsertChangesetMetadata } from "../../../../cache/changesets";
import { currentChangesetIndex } from "../../../../changeset/apply";
import { runApplyChangesets } from "../../../../commands/hub/changeset/apply";
import { HubMockFixture } from "../../../hub-mock-fixture";
import { testTempDir } from "../../../temp-workspace";

const fixture = new HubMockFixture();

/** An iModel with real pushed changesets, and a copy of the file from before they existed. */
interface Timeline {
  iModelId: string;
  /** The briefcase file as it was at changeset index 0. */
  baseFile: string;
  /** Indexes of the changesets that were pushed. */
  indexes: number[];
  /** Each changeset's cached file path, by index. */
  paths: Map<number, string>;
}

let timeline: Timeline;

beforeAll(async () => {
  await fixture.startup("changeset-apply");
  timeline = await buildTimeline();
}, 120_000);

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

/**
 * Push two changesets, keeping a copy of the file from before either was pushed.
 *
 * Real changesets rather than fabricated files: applying is native work with real parentage
 * checks, so a stand-in would not exercise it.
 */
async function buildTimeline(): Promise<Timeline> {
  const briefcase = await fixture.createBriefcase("timeline");
  const baseFile = join(testTempDir("base"), "at-zero.bim");
  copyFileSync(briefcase.fileName, baseFile);

  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, "cat", new SubCategoryAppearance());
  const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, "model");
  db.saveChanges();
  await db.pushChanges({ accessToken: "test-token", description: "model and category" });

  for (let i = 0; i < 2; i++) {
    db.elements.insertElement({
      classFullName: PhysicalObject.classFullName,
      model: modelId,
      category: categoryId,
      code: Code.createEmpty(),
      placement: { origin: [i, 0, 0], angles: {} },
    } as PhysicalElementProps);
    db.saveChanges();
    await db.pushChanges({ accessToken: "test-token", description: `element ${i}` });
  }
  db.close();

  // Cache the changesets exactly as `hub changeset download` would: metadata, then files.
  const changesets = await BriefcaseManager.downloadChangesets({
    iModelId: briefcase.iModelId,
    targetDir: BriefcaseManager.getChangeSetsPath(briefcase.iModelId),
  });
  upsertChangesetMetadata(
    briefcase.iModelId,
    changesets.map((c) => ({
      index: c.index, id: c.id, parentId: c.parentId, description: c.description,
      briefcaseId: c.briefcaseId, fileSize: c.size ?? statSync(c.pathname).size,
      containingChanges: c.changesType,
    })),
  );
  for (const changeset of changesets)
    recordChangesetFile(briefcase.iModelId, changeset.index, changeset.pathname);

  return {
    iModelId: briefcase.iModelId,
    baseFile,
    indexes: changesets.map((c) => c.index),
    paths: new Map(changesets.map((c) => [c.index, c.pathname])),
  };
}

function freshCopy(name: string): string {
  const copy = join(testTempDir(name), `${name}.bim`);
  copyFileSync(timeline.baseFile, copy);
  return copy;
}

describe("applying cached changesets", () => {
  it("walks an iModel forward to the target changeset", async () => {
    const file = freshCopy("forward");
    const target = timeline.indexes[timeline.indexes.length - 1];

    const result = await runApplyChangesets({ imodelPath: file, changesetIndex: target });

    expect(result.fromIndex).toBe(0);
    expect(result.toIndex).toBe(target);
    expect(result.applied).toBe(timeline.indexes.length);
  });

  it("leaves every changeset file in the cache", async () => {
    // The whole reason this does not use pullChanges, which deletes them as it applies.
    const file = freshCopy("keeps-files");
    const paths = timeline.indexes.map((index) =>
      join(BriefcaseManager.getChangeSetsPath(timeline.iModelId), "")); // directory, checked below

    await runApplyChangesets({ imodelPath: file, changesetIndex: timeline.indexes[1] });

    const dir = BriefcaseManager.getChangeSetsPath(timeline.iModelId);
    expect(existsSync(dir)).toBe(true);
    for (const index of timeline.indexes) {
      const cached = (await import("../../../../cache/changesets")).listCachedChangesets(
        timeline.iModelId, { start: index, end: index },
      )[0];
      expect(cached.filePath).toBeDefined();
      expect(existsSync(cached.filePath!)).toBe(true);
    }
    expect(paths.length).toBeGreaterThan(0);
  });

  it("stops part way when asked for an earlier target", async () => {
    const file = freshCopy("partial");

    const result = await runApplyChangesets({ imodelPath: file, changesetIndex: timeline.indexes[0] });

    expect(result.toIndex).toBe(timeline.indexes[0]);
    expect(result.applied).toBe(1);
  });

  it("does nothing when already at the target", async () => {
    const file = freshCopy("already-there");
    await runApplyChangesets({ imodelPath: file, changesetIndex: timeline.indexes[0] });

    const again = await runApplyChangesets({ imodelPath: file, changesetIndex: timeline.indexes[0] });

    expect(again.applied).toBe(0);
    expect(again.toIndex).toBe(timeline.indexes[0]);
  });

  it("accepts a changeset id as the target", async () => {
    const file = freshCopy("by-id");
    const { listCachedChangesets } = await import("../../../../cache/changesets");
    const first = listCachedChangesets(timeline.iModelId)[0];

    const result = await runApplyChangesets({ imodelPath: file, changesetId: first.id });

    expect(result.toIndex).toBe(first.index);
  });

  it("refuses to go backwards rather than silently doing nothing", async () => {
    const file = freshCopy("backwards");
    await runApplyChangesets({ imodelPath: file, changesetIndex: timeline.indexes[1] });

    await expect(runApplyChangesets({ imodelPath: file, changesetIndex: timeline.indexes[0] }))
      .rejects.toThrow(/already at changeset index .* Reversing changesets is not supported/);
  });

  it("reports a missing changeset file instead of applying a gap", async () => {
    const file = freshCopy("missing-file");
    const { clearChangesetFile } = await import("../../../../cache/changesets");
    clearChangesetFile(timeline.iModelId, timeline.indexes[0]);
    try {
      await expect(runApplyChangesets({ imodelPath: file, changesetIndex: timeline.indexes[1] }))
        .rejects.toThrow(/not downloaded/);
    } finally {
      recordChangesetFile(timeline.iModelId, timeline.indexes[0], timeline.paths.get(timeline.indexes[0])!);
    }
  });

  it("throws when the file does not exist", async () => {
    await expect(runApplyChangesets({ imodelPath: "/no/such/imodel.bim", changesetIndex: 1 }))
      .rejects.toThrow(/not found/);
  });

  it("requires a target", async () => {
    await expect(runApplyChangesets({ imodelPath: freshCopy("no-target") }))
      .rejects.toThrow(/--changeset-id or --changeset-index/);
  });

  it("fails loudly when a changeset does not apply, rather than reporting success", async () => {
    // `applyChangeset` does nothing when the changeset's parent is not the db's current
    // changeset, and it throws nothing -- so this guard is the only thing standing between
    // that and a command claiming success having changed nothing. Pointing the first
    // changeset's row at the second changeset's file produces exactly that mismatch.
    const file = freshCopy("guard");
    const [first, second] = timeline.indexes;
    const { listCachedChangesets } = await import("../../../../cache/changesets");
    const original = listCachedChangesets(timeline.iModelId, { start: first, end: first })[0];
    const later = listCachedChangesets(timeline.iModelId, { start: second, end: second })[0];

    // Corrupt metadata: the row for index 1 now describes changeset 2 entirely -- its id, its
    // parent and its file. The props are self-consistent, so the native id check passes, but
    // its parent is not the db's current changeset, which is the no-op case.
    getCacheDb()
      .prepare("UPDATE changesets SET changeset_id = ?, parent_id = ?, file_path = ? WHERE imodel_id = ? AND changeset_index = ?")
      .run(later.id, later.parentId ?? "", later.filePath!, timeline.iModelId, first);
    try {
      await expect(runApplyChangesets({ imodelPath: file, changesetIndex: first }))
        .rejects.toThrow(/did nothing/);
    } finally {
      getCacheDb()
        .prepare("UPDATE changesets SET changeset_id = ?, parent_id = ?, file_path = ? WHERE imodel_id = ? AND changeset_index = ?")
        .run(original.id, original.parentId ?? "", original.filePath!, timeline.iModelId, first);
    }
  });

  it("proves the hazard the guard is for: a mismatched parent applies nothing and throws nothing", async () => {
    // Straight to the native call, bypassing the contiguous walk, to show what
    // `applyChangeset` does on its own when the parent does not match.
    const file = freshCopy("native-noop");
    const { listCachedChangesets } = await import("../../../../cache/changesets");
    const second = listCachedChangesets(timeline.iModelId, { start: timeline.indexes[1], end: timeline.indexes[1] })[0];
    const db = SnapshotDb.openForApplyChangesets(file);
    try {
      const before = currentChangesetIndex(db);
      expect(before).toBe(0);

      db[_nativeDb].applyChangeset(
        {
          id: second.id, index: second.index, parentId: second.parentId ?? "",
          changesType: second.containingChanges ?? 0, description: second.description ?? "",
          briefcaseId: second.briefcaseId ?? 0, pushDate: second.pushDateTime ?? "",
          userCreated: second.creatorId ?? "", size: second.fileSize, pathname: second.filePath!,
        },
        false,
      );

      // No error, and no movement. This is why every apply is checked.
      expect(currentChangesetIndex(db)).toBe(before);
    } finally {
      db.close();
    }
  });
});

describe("a cache that has gone stale", () => {
  it("forgets a recorded file that is no longer on disk", async () => {
    // iTwin.js deletes changesets as it applies them, so anything that has been through
    // pullChanges -- a checkpoint download among them -- takes files the cache still claims.
    const file = freshCopy("stale");
    const first = timeline.indexes[0];
    const { listCachedChangesets } = await import("../../../../cache/changesets");
    const realPath = timeline.paths.get(first)!;
    recordChangesetFile(timeline.iModelId, first, `${realPath}.gone`);

    try {
      await expect(runApplyChangesets({ imodelPath: file, changesetIndex: first }))
        .rejects.toThrow(/not downloaded/);

      // The row no longer claims a file that is not there.
      expect(listCachedChangesets(timeline.iModelId, { start: first, end: first })[0].filePath)
        .toBeUndefined();
    } finally {
      recordChangesetFile(timeline.iModelId, first, realPath);
    }
  });
});

describe("a pull that deletes changesets as it applies them", () => {
  it("cannot take the ones this CLI downloaded", async () => {
    // The failure this guards: `imod hub checkpoint download` and anything else reaching
    // pullChanges deletes each changeset once applied. Observed for real -- ten downloaded,
    // a checkpoint taken at index 5, files 1-5 gone. The kept link is what survives it.
    const { keepChangesetFile, changesetFileName } = await import("../../../../cache/changeset-files");
    const { listCachedChangesets } = await import("../../../../cache/changesets");
    const first = timeline.indexes[0];

    // Put the changeset through the keep step the download command performs.
    const workPath = timeline.paths.get(first)!;
    const keepPath = keepChangesetFile(timeline.iModelId, listCachedChangesets(
      timeline.iModelId, { start: first, end: first },
    )[0].id, workPath);
    recordChangesetFile(timeline.iModelId, first, keepPath);

    // Exactly what iTwin.js does after applying: unlink its own name.
    rmSync(workPath, { force: true });
    expect(existsSync(workPath)).toBe(false);

    try {
      // The changeset is still usable, so applying still works.
      const file = freshCopy("survives-pull");
      const result = await runApplyChangesets({ imodelPath: file, changesetIndex: first });
      expect(result.applied).toBe(1);
      expect(existsSync(keepPath)).toBe(true);
    } finally {
      const { restoreChangesetFiles } = await import("../../../../cache/changeset-files");
      restoreChangesetFiles(timeline.iModelId);
      recordChangesetFile(timeline.iModelId, first, workPath);
      expect(changesetFileName).toBeDefined();
    }
  });
});
