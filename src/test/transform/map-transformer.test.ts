import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BriefcaseDb, EditTxn, PhysicalModel, SpatialCategory } from "@itwin/core-backend";
import {
  Code,
  GeometryStreamBuilder,
  IModel,
  SubCategoryAppearance,
  type GeometryStreamProps,
  type PhysicalElementProps,
  type RelationshipProps,
} from "@itwin/core-common";
import { Box, Range3d } from "@itwin/core-geometry";
import { DbResult } from "@itwin/core-bentley";
import { countBySourceClass, resolvePropertyMap, runMapTransform, type MapTransformResult, type ResolvedClassMapping } from "../../transform/map-transformer";
import type { ClassMapping } from "../../transform/mapping-file";
import { closeCacheDb } from "../../cache/cache-db";
import { HubMockFixture } from "../hub-mock-fixture";

const fixture = new HubMockFixture();
let cacheDir: string;
let schemaFile: string;
let schemaDir: string;

const SCHEMA = `<?xml version="1.0" encoding="UTF-8"?>
<ECSchema schemaName="TransformTest" alias="tt" version="01.00.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.2">
  <ECSchemaReference name="BisCore" version="01.00.00" alias="bis"/>
  <ECEntityClass typeName="SourceObject" modifier="None">
    <BaseClass>bis:PhysicalElement</BaseClass>
    <ECProperty propertyName="Banana" typeName="string"/>
    <ECProperty propertyName="Shared" typeName="string"/>
  </ECEntityClass>
  <ECEntityClass typeName="TargetObject" modifier="None">
    <BaseClass>bis:PhysicalElement</BaseClass>
    <ECProperty propertyName="Apple" typeName="string"/>
    <ECProperty propertyName="Shared" typeName="string"/>
  </ECEntityClass>
  <ECEntityClass typeName="Referrer" modifier="None">
    <BaseClass>bis:PhysicalElement</BaseClass>
    <ECNavigationProperty propertyName="SourceRef" relationshipName="ReferrerRefersToSource" direction="Forward"/>
  </ECEntityClass>
  <ECRelationshipClass typeName="ReferrerRefersToSource" strength="referencing" modifier="None">
    <Source multiplicity="(0..*)" roleLabel="refers to" polymorphic="true"><Class class="Referrer"/></Source>
    <Target multiplicity="(0..1)" roleLabel="is referenced by" polymorphic="true"><Class class="bis:PhysicalElement"/></Target>
  </ECRelationshipClass>
  <ECRelationshipClass typeName="LinkToSource" strength="referencing" modifier="Sealed">
    <BaseClass>bis:ElementRefersToElements</BaseClass>
    <Source multiplicity="(0..*)" roleLabel="links" polymorphic="true"><Class class="bis:PhysicalElement"/></Source>
    <Target multiplicity="(0..*)" roleLabel="linked by" polymorphic="true"><Class class="bis:PhysicalElement"/></Target>
  </ECRelationshipClass>
  <ECEntityClass typeName="SourceAspect" modifier="None"><BaseClass>bis:ElementUniqueAspect</BaseClass><ECProperty propertyName="Note" typeName="string"/></ECEntityClass>
  <ECEntityClass typeName="TargetAspect" modifier="None"><BaseClass>bis:ElementUniqueAspect</BaseClass><ECProperty propertyName="Note" typeName="string"/></ECEntityClass>
  <ECRelationshipClass typeName="SourceRel" strength="referencing" modifier="Sealed">
    <BaseClass>bis:ElementRefersToElements</BaseClass>
    <Source multiplicity="(0..*)" roleLabel="refers" polymorphic="true"><Class class="bis:PhysicalElement"/></Source>
    <Target multiplicity="(0..*)" roleLabel="referenced" polymorphic="true"><Class class="bis:PhysicalElement"/></Target>
  </ECRelationshipClass>
  <ECRelationshipClass typeName="TargetRel" strength="referencing" modifier="Sealed">
    <BaseClass>bis:ElementRefersToElements</BaseClass>
    <Source multiplicity="(0..*)" roleLabel="refers" polymorphic="true"><Class class="bis:PhysicalElement"/></Source>
    <Target multiplicity="(0..*)" roleLabel="referenced" polymorphic="true"><Class class="bis:PhysicalElement"/></Target>
  </ECRelationshipClass>
</ECSchema>`;

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "imod-map-transformer-cache-"));
  process.env.IMOD_CACHE_DIR = cacheDir;
  await fixture.startup("map-transformer");
  schemaDir = mkdtempSync(join(tmpdir(), "imod-map-transformer-schema-"));
  schemaFile = join(schemaDir, "TransformTest.ecschema.xml");
  writeFileSync(schemaFile, SCHEMA, "utf8");
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(schemaDir, { recursive: true, force: true });
});

function boxGeom(): GeometryStreamProps {
  const builder = new GeometryStreamBuilder();
  const box = Box.createRange(Range3d.createXYZXYZ(0, 0, 0, 1, 1, 1), true);
  if (box) builder.appendGeometry(box);
  return builder.geometryStream;
}

interface Seeded {
  fileName: string;
  modelId: string;
  count: number;
}

/** Create a briefcase with the test schema and `count` SourceObject elements. */
async function seed(name: string, count: number, values: { banana?: string; shared?: string }): Promise<Seeded> {
  const briefcase = await fixture.createBriefcase(name);
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  let modelId = "";
  try {
    await db.acquireSchemaLock();
    await db.importSchemas([schemaFile]);
    const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, `${name}-cat`, new SubCategoryAppearance());
    modelId = PhysicalModel.insert(db, IModel.rootSubjectId, `${name}-model`);
    for (let i = 0; i < count; i++) {
      const props: PhysicalElementProps = {
        classFullName: "TransformTest:SourceObject",
        model: modelId,
        category: categoryId,
        code: Code.createEmpty(),
        placement: { origin: [0, 0, i], angles: {} },
        geom: boxGeom(),
      };
      (props as Record<string, unknown>).banana = values.banana;
      (props as Record<string, unknown>).shared = values.shared;
      db.elements.insertElement(props);
    }
    db.saveChanges();
  } finally {
    db.close();
  }
  return { fileName: briefcase.fileName, modelId, count };
}

interface SeededWithRefs {
  fileName: string;
  sourceId: string;
  referrerId: string;
}

/** Create a briefcase with one SourceObject plus a navigation and link-table reference to it. */
async function seedWithInbound(name: string): Promise<SeededWithRefs> {
  const briefcase = await fixture.createBriefcase(name);
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  let sourceId = "";
  let referrerId = "";
  try {
    await db.acquireSchemaLock();
    await db.importSchemas([schemaFile]);
    const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, `${name}-cat`, new SubCategoryAppearance());
    const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, `${name}-model`);
    const src: PhysicalElementProps = {
      classFullName: "TransformTest:SourceObject",
      model: modelId, category: categoryId, code: Code.createEmpty(),
      placement: { origin: [0, 0, 0], angles: {} }, geom: boxGeom(),
    };
    (src as Record<string, unknown>).banana = "b";
    (src as Record<string, unknown>).shared = "s";
    sourceId = db.elements.insertElement(src);

    const ref: PhysicalElementProps = {
      classFullName: "TransformTest:Referrer",
      model: modelId, category: categoryId, code: Code.createEmpty(),
      placement: { origin: [0, 0, 1], angles: {} }, geom: boxGeom(),
    };
    (ref as Record<string, unknown>).sourceRef = { id: sourceId, relClassName: "TransformTest:ReferrerRefersToSource" };
    referrerId = db.elements.insertElement(ref);

    db.relationships.insertInstance({
      classFullName: "TransformTest:LinkToSource",
      sourceId: referrerId,
      targetId: sourceId,
    } as RelationshipProps);
    db.saveChanges();
  } finally {
    db.close();
  }
  return { fileName: briefcase.fileName, sourceId, referrerId };
}

/** Create a briefcase with two holder elements, a SourceAspect on the first, and a SourceRel between them. */
async function seedAspectRel(name: string): Promise<{ fileName: string; e1: string; e2: string }> {
  const briefcase = await fixture.createBriefcase(name);
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  let e1 = "";
  let e2 = "";
  try {
    await db.acquireSchemaLock();
    await db.importSchemas([schemaFile]);
    const cat = SpatialCategory.insert(db, IModel.dictionaryId, `${name}-cat`, new SubCategoryAppearance());
    const model = PhysicalModel.insert(db, IModel.rootSubjectId, `${name}-model`);
    const holder = (z: number): PhysicalElementProps => ({
      classFullName: "TransformTest:SourceObject",
      model, category: cat, code: Code.createEmpty(),
      placement: { origin: [0, 0, z], angles: {} }, geom: boxGeom(),
    });
    e1 = db.elements.insertElement(holder(0));
    e2 = db.elements.insertElement(holder(1));
    db.elements.insertAspect({ classFullName: "TransformTest:SourceAspect", element: { id: e1 }, note: "a" } as never);
    db.relationships.insertInstance({ classFullName: "TransformTest:SourceRel", sourceId: e1, targetId: e2 } as RelationshipProps);
    db.saveChanges();
  } finally {
    db.close();
  }
  return { fileName: briefcase.fileName, e1, e2 };
}

function aspectMapping(): ClassMapping {
  return {
    SourceClass: "TransformTest:SourceAspect",
    TargetClass: "TransformTest:TargetAspect",
    Options: { AutoMapLikeNamedProperties: true },
  };
}

function relationshipMapping(): ClassMapping {
  return { SourceClass: "TransformTest:SourceRel", TargetClass: "TransformTest:TargetRel" };
}

function autoMapMapping(): ClassMapping {
  return {
    SourceClass: "TransformTest:SourceObject",
    TargetClass: "TransformTest:TargetObject",
    Options: { AutoMapLikeNamedProperties: true },
    PropertyMappings: [{ SourceProperty: "Banana", TargetProperty: "Apple", Options: { DefaultValueIfEmpty: "n/a" } }],
  };
}

/**
 * Run the transform in its own explicit EditTxn, as the command does, with implicit writes
 * rejected for the duration. That is what proves every write in the transform really goes
 * through the transaction: a single stray `db.elements.*` call throws instead of quietly
 * succeeding through the implicit transaction.
 */
async function transform(db: BriefcaseDb, resolved: ResolvedClassMapping[]): Promise<MapTransformResult> {
  const enforcement = EditTxn.implicitWriteEnforcement;
  EditTxn.implicitWriteEnforcement = "throw";
  const editTxn = new EditTxn(db, "test transform");
  editTxn.start();
  try {
    const result = await runMapTransform(editTxn, resolved);
    editTxn.end("save", "test transform");
    return result;
  } catch (err) {
    if (editTxn.isActive)
      editTxn.end("abandon");
    throw err;
  } finally {
    EditTxn.implicitWriteEnforcement = enforcement;
  }
}

describe("map-transformer", () => {
  describe("runMapTransform", () => {
    it("converts source elements to the target class in place and leaves a pushable changeset", async () => {
      const seeded = await seed("convert", 3, { banana: "b", shared: "s" });

      let db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: false });
      let result;
      try {
        const resolved = [await resolvePropertyMap(db, autoMapMapping())];
        result = await transform(db, resolved);
      } finally {
        db.close();
      }
      expect(result.converted).toBe(3);

      db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: true });
      try {
        expect(db.txns.hasPendingTxns).toBe(true);
        expect(count(db, "ONLY TransformTest.SourceObject")).toBe(0);
        expect(count(db, "ONLY TransformTest.TargetObject")).toBe(3);
        // PhysicalModel was not duplicated; converted elements stayed in the original model.
        expect(count(db, "bis.PhysicalModel")).toBe(1);
        const rows = readTargets(db);
        expect(rows).toHaveLength(3);
        for (const r of rows) {
          expect(r.apple).toBe("b"); // Banana -> Apple
          expect(r.shared).toBe("s"); // auto-mapped like-named property
          expect(r.model).toBe(seeded.modelId);
        }
      } finally {
        db.close();
      }
    });

    it("applies DefaultValueIfEmpty when the source value is empty", async () => {
      const seeded = await seed("default", 1, { banana: "", shared: "s" });
      let db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: false });
      try {
        const resolved = [await resolvePropertyMap(db, autoMapMapping())];
        await transform(db, resolved);
      } finally {
        db.close();
      }
      db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: true });
      try {
        expect(readTargets(db)[0].apple).toBe("n/a");
      } finally {
        db.close();
      }
    });
  });

  describe("countBySourceClass", () => {
    it("counts elements per source class without modifying the briefcase", async () => {
      const seeded = await seed("count", 4, { banana: "b", shared: "s" });
      const db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: true });
      try {
        const resolved = [await resolvePropertyMap(db, autoMapMapping())];
        const counts = await countBySourceClass(db, resolved);
        expect(counts["TransformTest:SourceObject"]).toBe(4);
        // Counting must not convert anything: the source elements are still present.
        expect(count(db, "ONLY TransformTest.SourceObject")).toBe(4);
        expect(count(db, "ONLY TransformTest.TargetObject")).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  describe("inbound references", () => {
    it("re-points navigation and link-table references onto the converted element", async () => {
      const seeded = await seedWithInbound("inbound");

      let db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: false });
      let result;
      try {
        const resolved = [await resolvePropertyMap(db, autoMapMapping())];
        result = await transform(db, resolved);
      } finally {
        db.close();
      }
      expect(result.converted).toBe(1);
      expect(result.navReferencesRepointed).toBe(1);
      expect(result.linkRelationshipsRepointed).toBe(1);

      db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: true });
      try {
        expect(count(db, "ONLY TransformTest.SourceObject")).toBe(0);
        const targetId = db.withPreparedStatement(
          "SELECT ECInstanceId FROM ONLY TransformTest.TargetObject",
          (s) => { s.step(); return s.getValue(0).getId(); },
        );
        const ref = db.elements.getElementProps(seeded.referrerId) as unknown as { sourceRef?: { id: string } };
        expect(ref.sourceRef?.id).toBe(targetId);
        expect(count(db, "TransformTest.LinkToSource")).toBe(1);
        const linkTarget = db.withPreparedStatement(
          "SELECT TargetECInstanceId FROM TransformTest.LinkToSource",
          (s) => { s.step(); return s.getValue(0).getId(); },
        );
        expect(linkTarget).toBe(targetId);
      } finally {
        db.close();
      }
    });
  });

  describe("aspect and relationship classes", () => {
    it("re-classes aspect and relationship instances to their target classes", async () => {
      const seeded = await seedAspectRel("aspectrel");

      let db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: false });
      let result;
      try {
        const resolved = [
          await resolvePropertyMap(db, aspectMapping()),
          await resolvePropertyMap(db, relationshipMapping()),
        ];
        result = await transform(db, resolved);
      } finally {
        db.close();
      }
      expect(result.converted).toBe(0);
      expect(result.aspectsConverted).toBe(1);
      expect(result.relationshipsConverted).toBe(1);

      db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: true });
      try {
        expect(count(db, "ONLY TransformTest.SourceAspect")).toBe(0);
        expect(count(db, "ONLY TransformTest.TargetAspect")).toBe(1);
        expect(count(db, "ONLY TransformTest.SourceRel")).toBe(0);
        expect(count(db, "ONLY TransformTest.TargetRel")).toBe(1);
        const aspects = db.elements.getAspects(seeded.e1, "TransformTest:TargetAspect");
        expect((aspects[0].toJSON() as unknown as { note: string }).note).toBe("a");
        const rel = db.withPreparedStatement(
          "SELECT SourceECInstanceId, TargetECInstanceId FROM ONLY TransformTest.TargetRel",
          (s) => { s.step(); return { src: s.getValue(0).getId(), tgt: s.getValue(1).getId() }; },
        );
        expect(rel).toEqual({ src: seeded.e1, tgt: seeded.e2 });
      } finally {
        db.close();
      }
    });
  });

  describe("resolvePropertyMap ambiguity", () => {
    it("fails when a like-named source property is unmapped and AutoMap is disabled", async () => {
      const seeded = await seed("ambig-auto", 1, { banana: "b", shared: "s" });
      const db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: true });
      try {
        await expect(
          resolvePropertyMap(db, {
            SourceClass: "TransformTest:SourceObject",
            TargetClass: "TransformTest:TargetObject",
            PropertyMappings: [{ SourceProperty: "Banana", TargetProperty: "Apple" }],
          }),
        ).rejects.toThrow(/Shared.*AutoMapLikeNamedProperties|Ambiguous/);
      } finally {
        db.close();
      }
    });

    it("fails when a source property has no target and no mapping", async () => {
      const seeded = await seed("ambig-drop", 1, { banana: "b", shared: "s" });
      const db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: true });
      try {
        // Map Shared but leave Banana unmapped with no Apple-like target -> data loss.
        await expect(
          resolvePropertyMap(db, {
            SourceClass: "TransformTest:SourceObject",
            TargetClass: "TransformTest:TargetObject",
            PropertyMappings: [{ SourceProperty: "Shared", TargetProperty: "Shared" }],
          }),
        ).rejects.toThrow(/"Banana" has no matching property/);
      } finally {
        db.close();
      }
    });

    it("fails when the source or target class is not found", async () => {
      const seeded = await seed("ambig-class", 1, { banana: "b", shared: "s" });
      const db = await BriefcaseDb.open({ fileName: seeded.fileName, readonly: true });
      try {
        await expect(
          resolvePropertyMap(db, { SourceClass: "TransformTest:Nope", TargetClass: "TransformTest:TargetObject" }),
        ).rejects.toThrow(/SourceClass not found/);
      } finally {
        db.close();
      }
    });
  });
});

function count(db: BriefcaseDb, fromClause: string): number {
  return db.withPreparedStatement(`SELECT COUNT(*) FROM ${fromClause}`, (s) => {
    s.step();
    return s.getValue(0).getInteger();
  });
}

function readTargets(db: BriefcaseDb): { apple: string; shared: string; model: string }[] {
  return db.withPreparedStatement(
    "SELECT Apple, Shared, Model.Id FROM ONLY TransformTest.TargetObject",
    (s) => {
      const out: { apple: string; shared: string; model: string }[] = [];
      while (s.step() === DbResult.BE_SQLITE_ROW)
        out.push({ apple: s.getValue(0).getString(), shared: s.getValue(1).getString(), model: s.getValue(2).getId() });
      return out;
    },
  );
}
