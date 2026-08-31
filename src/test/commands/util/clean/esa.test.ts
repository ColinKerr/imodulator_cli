import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { BriefcaseDb, ExternalSourceAspect, PhysicalModel, SpatialCategory } from "@itwin/core-backend";
import { Code, IModel, SubCategoryAppearance, type ExternalSourceAspectProps, type PhysicalElementProps } from "@itwin/core-common";
import type { Id64String } from "@itwin/core-bentley";
import { runCleanEsa } from "../../../../commands/util/clean/esa";
import { closeCacheDb } from "../../../../cache/cache-db";
import { HubMockFixture, type TestBriefcase } from "../../../hub-mock-fixture";
import { testCacheDir } from "../../../temp-workspace";

const fixture = new HubMockFixture();
let cacheDir: string;

beforeAll(async () => {
  cacheDir = testCacheDir();
  await fixture.startup("clean-esa");
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

interface Identity {
  kind: string;
  identifier: string;
  /** Insert with no Scope at all, which BisCore permits. */
  noScope?: boolean;
  /** ExternalSourceAspect.JsonProperties, part of the identity. */
  jsonProperties?: string;
}

/** Every aspect on the element, as identity keys, so survivors can be compared. */
function aspectIdentities(db: BriefcaseDb, elementId: Id64String): string[] {
  return db.elements
    .getAspects(elementId, ExternalSourceAspect.classFullName)
    .map((a) => {
      const esa = a as ExternalSourceAspect;
      return `${esa.scope?.id ?? "none"}|${esa.kind}|${esa.identifier}|${esa.jsonProperties ?? "none"}`;
    })
    .sort();
}

function aspectCount(db: BriefcaseDb, elementId: Id64String): number {
  return db.elements.getAspects(elementId, ExternalSourceAspect.classFullName).length;
}

/**
 * A briefcase with one element carrying the requested aspects. Nothing in BisCore enforces
 * uniqueness on an ExternalSourceAspect -- its index is explicitly not unique -- so identical
 * aspects can simply be inserted, which is how duplicates arise in the wild.
 */
async function seed(name: string, identities: Identity[]): Promise<{ briefcase: TestBriefcase; elementId: Id64String }> {
  const briefcase = await fixture.createBriefcase(name);
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  try {
    const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, `${name}-cat`, new SubCategoryAppearance());
    const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, `${name}-model`);
    const props: PhysicalElementProps = {
      classFullName: "Generic:PhysicalObject",
      model: modelId,
      category: categoryId,
      code: Code.createEmpty(),
      placement: { origin: [0, 0, 0], angles: {} },
    };
    const elementId = db.elements.insertElement(props);

    for (const identity of identities) {
      const aspect: ExternalSourceAspectProps = {
        classFullName: ExternalSourceAspect.classFullName,
        element: { id: elementId },
        scope: { id: IModel.rootSubjectId },
        kind: identity.kind,
        identifier: identity.identifier,
      };
      if (identity.noScope)
        delete (aspect as Partial<ExternalSourceAspectProps>).scope;
      if (identity.jsonProperties !== undefined)
        aspect.jsonProperties = identity.jsonProperties;
      db.elements.insertAspect(aspect);
    }
    db.saveChanges();
    return { briefcase, elementId };
  } finally {
    db.close();
  }
}

async function withReadonly<T>(fileName: string, fn: (db: BriefcaseDb) => T): Promise<T> {
  const db = await BriefcaseDb.open({ fileName, readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe("imod util clean esa", () => {
  it("leaves exactly one aspect per identity and keeps the distinct ones", async () => {
    const { briefcase, elementId } = await seed("duplicates", [
      { kind: "Element", identifier: "a" },
      { kind: "Element", identifier: "a" },
      { kind: "Element", identifier: "a" },
      { kind: "Element", identifier: "b" },
      { kind: "Element", identifier: "b" },
      // Same identifier, different Kind: a different identity, not a duplicate.
      { kind: "Relationship", identifier: "a" },
    ]);

    const before = await withReadonly(briefcase.fileName, (db) => aspectCount(db, elementId));
    expect(before).toBe(6);

    const result = await runCleanEsa({ imodelPath: briefcase.fileName });

    expect(result.duplicateGroups).toBe(2);
    expect(result.redundant).toBe(3);
    expect(result.deleted).toBe(3);
    expect(result.largestGroup).toBe(3);

    await withReadonly(briefcase.fileName, (db) => {
      expect(aspectCount(db, elementId)).toBe(3);
      // One survivor per identity, and the near miss untouched.
      expect(aspectIdentities(db, elementId)).toEqual([
        `${IModel.rootSubjectId}|Element|a|none`,
        `${IModel.rootSubjectId}|Element|b|none`,
        `${IModel.rootSubjectId}|Relationship|a|none`,
      ]);
      expect(db.txns.hasPendingTxns).toBe(true);
    });
  });

  it("treats aspects that differ only by JsonProperties as different identities", async () => {
    const { briefcase, elementId } = await seed("json-differs", [
      { kind: "Element", identifier: "a", jsonProperties: `{"v":1}` },
      { kind: "Element", identifier: "a", jsonProperties: `{"v":2}` },
      { kind: "Element", identifier: "a", jsonProperties: `{"v":2}` },
      // No JsonProperties at all is a third identity, not a match for either.
      { kind: "Element", identifier: "a" },
    ]);

    const result = await runCleanEsa({ imodelPath: briefcase.fileName });

    // Only the two identical `{"v":2}` aspects are duplicates of each other.
    expect(result.duplicateGroups).toBe(1);
    expect(result.redundant).toBe(1);
    expect(result.deleted).toBe(1);

    await withReadonly(briefcase.fileName, (db) => {
      expect(aspectIdentities(db, elementId)).toEqual([
        `${IModel.rootSubjectId}|Element|a|none`,
        `${IModel.rootSubjectId}|Element|a|{"v":1}`,
        `${IModel.rootSubjectId}|Element|a|{"v":2}`,
      ]);
    });
  });

  it("deletes duplicates that carry the same JsonProperties", async () => {
    const { briefcase, elementId } = await seed("json-same", [
      { kind: "Element", identifier: "a", jsonProperties: `{"source":"x","n":1}` },
      { kind: "Element", identifier: "a", jsonProperties: `{"source":"x","n":1}` },
      { kind: "Element", identifier: "a", jsonProperties: `{"source":"x","n":1}` },
    ]);

    const result = await runCleanEsa({ imodelPath: briefcase.fileName });

    expect(result.duplicateGroups).toBe(1);
    expect(result.deleted).toBe(2);
    await withReadonly(briefcase.fileName, (db) => {
      expect(aspectCount(db, elementId)).toBe(1);
      // The survivor keeps its JsonProperties rather than losing them to the delete.
      expect(aspectIdentities(db, elementId)).toEqual([
        `${IModel.rootSubjectId}|Element|a|{"source":"x","n":1}`,
      ]);
    });
  });

  it("treats two aspects with no scope as the same identity", async () => {
    const { briefcase, elementId } = await seed("null-scope", [
      { kind: "Element", identifier: "x", noScope: true },
      { kind: "Element", identifier: "x", noScope: true },
    ]);

    // Confirm the aspects really landed without a scope before relying on that.
    const scopes = await withReadonly(briefcase.fileName, (db) =>
      db.elements.getAspects(elementId, ExternalSourceAspect.classFullName).map((a) => (a as ExternalSourceAspect).scope?.id),
    );
    expect(scopes).toHaveLength(2);
    expect(scopes.every((id) => id === undefined)).toBe(true);

    const result = await runCleanEsa({ imodelPath: briefcase.fileName });

    expect(result.redundant).toBe(1);
    expect(await withReadonly(briefcase.fileName, (db) => aspectCount(db, elementId))).toBe(1);
  });

  it("does not merge identical identities that belong to different elements", async () => {
    // The grouping runs over the whole table, so Element.Id has to be part of the key: two
    // elements each carrying the same aspect twice is two groups of two, not one group of four.
    const briefcase = await fixture.createBriefcase("two-elements");
    const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
    const elementIds: Id64String[] = [];
    try {
      const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, "two-cat", new SubCategoryAppearance());
      const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, "two-model");
      for (let i = 0; i < 2; i++) {
        const elementId = db.elements.insertElement({
          classFullName: "Generic:PhysicalObject",
          model: modelId,
          category: categoryId,
          code: Code.createEmpty(),
          placement: { origin: [0, 0, 0], angles: {} },
        } as PhysicalElementProps);
        elementIds.push(elementId);
        for (let n = 0; n < 2; n++)
          db.elements.insertAspect({
            classFullName: ExternalSourceAspect.classFullName,
            element: { id: elementId },
            scope: { id: IModel.rootSubjectId },
            kind: "Element",
            identifier: "shared",
            jsonProperties: `{"v":1}`,
          } as ExternalSourceAspectProps);
      }
      db.saveChanges();
    } finally {
      db.close();
    }

    const result = await runCleanEsa({ imodelPath: briefcase.fileName });

    expect(result.duplicateGroups).toBe(2);
    expect(result.redundant).toBe(2);
    expect(result.deleted).toBe(2);
    // Each element keeps its own aspect; neither is left with none.
    await withReadonly(briefcase.fileName, (readDb) => {
      for (const elementId of elementIds)
        expect(aspectCount(readDb, elementId)).toBe(1);
    });
  });

  it("dry run reports the duplicates without deleting them", async () => {
    const { briefcase, elementId } = await seed("dry-run", [
      { kind: "Element", identifier: "a" },
      { kind: "Element", identifier: "a" },
    ]);

    const result = await runCleanEsa({ imodelPath: briefcase.fileName, dryRun: true });

    expect(result.redundant).toBe(1);
    expect(result.deleted).toBe(0);
    expect(await withReadonly(briefcase.fileName, (db) => aspectCount(db, elementId))).toBe(2);
  });

  it("is idempotent: a second run finds nothing to do", async () => {
    const { briefcase, elementId } = await seed("idempotent", [
      { kind: "Element", identifier: "a" },
      { kind: "Element", identifier: "a" },
    ]);

    const first = await runCleanEsa({ imodelPath: briefcase.fileName });
    expect(first.deleted).toBe(1);

    const second = await runCleanEsa({ imodelPath: briefcase.fileName });
    expect(second.duplicateGroups).toBe(0);
    expect(second.redundant).toBe(0);
    expect(second.deleted).toBe(0);
    expect(await withReadonly(briefcase.fileName, (db) => aspectCount(db, elementId))).toBe(1);
  });

  it("does nothing to an iModel whose aspects are all distinct", async () => {
    const { briefcase, elementId } = await seed("distinct", [
      { kind: "Element", identifier: "a" },
      { kind: "Element", identifier: "b" },
    ]);

    const result = await runCleanEsa({ imodelPath: briefcase.fileName });

    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(0);
    expect(await withReadonly(briefcase.fileName, (db) => aspectCount(db, elementId))).toBe(2);
  });

  it("leaves the deletions in a pushable changeset", async () => {
    const { briefcase, elementId } = await seed("pushable", [
      { kind: "Element", identifier: "a" },
      { kind: "Element", identifier: "a" },
    ]);

    // Push the seed so pending txns start clean and the delete is the only candidate.
    let db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
    try {
      await db.pushChanges({ accessToken: "test-token", description: "seed" });
      expect(db.txns.hasPendingTxns).toBe(false);
    } finally {
      db.close();
    }

    await runCleanEsa({ imodelPath: briefcase.fileName });

    // The delete goes through raw SQLite rather than the aspect API, so this is what proves
    // it is still recorded as a local change rather than an untracked edit to the file.
    db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: true });
    try {
      expect(db.txns.hasPendingTxns).toBe(true);
      expect(aspectCount(db, elementId)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("throws when the iModel file does not exist", async () => {
    await expect(runCleanEsa({ imodelPath: "/no/such/imodel.bim" })).rejects.toThrow(/not found/);
  });
});
