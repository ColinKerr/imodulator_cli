import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BriefcaseDb, PhysicalModel, SpatialCategory } from "@itwin/core-backend";
import { DbResult, Guid } from "@itwin/core-bentley";
import {
  Code,
  IModel,
  SubCategoryAppearance,
  type PhysicalElementProps,
} from "@itwin/core-common";
import { guidToBlob, runSetFedGuids } from "../../../commands/util/set-fed-guids";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();

beforeAll(async () => {
  await fixture.startup("set-fed-guids");
});

afterAll(async () => {
  await fixture.shutdown();
});

/**
 * A briefcase with `unsetCount` elements that have no FederationGuid and `setCount` that
 * do. Inserting with `Guid.empty` is the documented way to get an element with none.
 */
async function seedBriefcase(
  name: string,
  unsetCount: number,
  setCount: number,
): Promise<{ briefcase: TestBriefcase; unsetIds: string[]; preset: Map<string, string> }> {
  const briefcase = await fixture.createBriefcase(name);
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  try {
    const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, `${name}-cat`, new SubCategoryAppearance());
    const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, `${name}-model`);

    const insert = (federationGuid?: string): string => {
      const props: PhysicalElementProps = {
        classFullName: "Generic:PhysicalObject",
        model: modelId,
        category: categoryId,
        code: Code.createEmpty(),
        placement: { origin: [0, 0, 0], angles: {} },
        federationGuid,
      };
      return db.elements.insertElement(props);
    };

    const unsetIds: string[] = [];
    for (let i = 0; i < unsetCount; i++)
      unsetIds.push(insert(Guid.empty));

    const preset = new Map<string, string>();
    for (let i = 0; i < setCount; i++) {
      const guid = Guid.createValue();
      preset.set(insert(guid), guid);
    }

    db.saveChanges();
    return { briefcase, unsetIds, preset };
  } finally {
    db.close();
  }
}

function countUnset(db: BriefcaseDb): number {
  return db.withSqliteStatement(
    "SELECT COUNT(*) FROM bis_Element WHERE FederationGuid IS NULL",
    (stmt) => {
      expect(stmt.step()).toBe(DbResult.BE_SQLITE_ROW);
      return stmt.getValueInteger(0);
    },
  );
}

async function withReadonly<T>(fileName: string, fn: (db: BriefcaseDb) => T | Promise<T>): Promise<T> {
  const db = await BriefcaseDb.open({ fileName, readonly: true });
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

describe("guidToBlob", () => {
  it("encodes a GUID in canonical byte order", () => {
    // Pinned against real stored data: this blob is read back by the element API as this
    // GUID. A byte-swapped ("Microsoft GUID") encoding would still look like a valid GUID
    // but would not match, so this assertion is what guards the format.
    const blob = guidToBlob("000002a6-3c68-4a0d-9876-3f36358ca43b");
    expect(Buffer.from(blob).toString("hex").toUpperCase()).toBe("000002A63C684A0D98763F36358CA43B");
  });

  it("always produces 16 bytes", () => {
    for (let i = 0; i < 20; i++)
      expect(guidToBlob(Guid.createValue())).toHaveLength(16);
  });

  it("rejects anything that is not a GUID", () => {
    for (const bad of ["", "not-a-guid", "000002a6-3c68-4a0d-9876", `${Guid.createValue()}00`])
      expect(() => guidToBlob(bad)).toThrow(/Not a GUID/);
  });
});

describe("imod util set-fed-guids", () => {
  it("assigns a GUID to every element that lacks one, leaving the rest alone", async () => {
    const { briefcase, unsetIds, preset } = await seedBriefcase("assign", 5, 3);

    const before = await withReadonly(briefcase.fileName, countUnset);
    expect(before).toBeGreaterThanOrEqual(unsetIds.length);

    const result = await runSetFedGuids({ imodelPath: briefcase.fileName });

    expect(result.unsetBefore).toBe(before);
    expect(result.updated).toBe(before);
    expect(result.failed).toBe(0);
    expect(result.unsetAfter).toBe(0);

    await withReadonly(briefcase.fileName, (db) => {
      expect(countUnset(db)).toBe(0);

      // Every seeded element now has a GUID, and they are all distinct.
      const assigned = new Set<string>();
      for (const id of unsetIds) {
        const guid = db.elements.getElementProps(id).federationGuid;
        expect(guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assigned.add(guid!);
      }
      expect(assigned.size).toBe(unsetIds.length);

      // Elements that already had one keep exactly the GUID they were given.
      for (const [id, guid] of preset)
        expect(db.elements.getElementProps(id).federationGuid).toBe(guid);
    });
  });

  it("is idempotent: a second run has nothing to assign", async () => {
    const { briefcase } = await seedBriefcase("idempotent", 3, 1);

    const first = await runSetFedGuids({ imodelPath: briefcase.fileName });
    expect(first.updated).toBeGreaterThan(0);

    const second = await runSetFedGuids({ imodelPath: briefcase.fileName });
    expect(second.unsetBefore).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unsetAfter).toBe(0);
  });

  it("dry run reports the work without writing anything", async () => {
    const { briefcase } = await seedBriefcase("dryrun", 4, 1);
    const before = await withReadonly(briefcase.fileName, countUnset);

    const result = await runSetFedGuids({ imodelPath: briefcase.fileName, dryRun: true });

    expect(result.unsetBefore).toBe(before);
    expect(result.updated).toBe(0);
    expect(result.unsetAfter).toBe(before);
    // The file is untouched, so a real run still has the same work to do.
    expect(await withReadonly(briefcase.fileName, countUnset)).toBe(before);
  });

  it("throws when the iModel file does not exist", async () => {
    await expect(runSetFedGuids({ imodelPath: "/no/such/imodel.bim" })).rejects.toThrow(/not found/);
  });
});
