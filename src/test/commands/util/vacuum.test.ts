import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { BriefcaseDb, PhysicalModel, SpatialCategory } from "@itwin/core-backend";
import {
  Code,
  ElementGeometry,
  IModel,
  SubCategoryAppearance,
  type PhysicalElementProps,
} from "@itwin/core-common";
import { Box, Range3d } from "@itwin/core-geometry";
import { formatBytes, formatDuration, runVacuum } from "../../../commands/util/vacuum";
import { HubMockFixture } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();

beforeAll(async () => {
  await fixture.startup("vacuum");
});

afterAll(async () => {
  await fixture.shutdown();
});

/** Entries for a chunk of geometry big enough to leave free pages behind when deleted. */
function boxEntries(boxCount: number) {
  const builder = new ElementGeometry.Builder();
  for (let i = 0; i < boxCount; i++) {
    const box = Box.createRange(Range3d.createXYZXYZ(0, 0, i, 1, 1, i + 1), true);
    if (box)
      builder.appendGeometryQuery(box);
  }
  return builder.entries;
}

/**
 * A briefcase carrying free pages: elements are inserted, saved, then deleted and saved
 * again, so the file holds space that vacuum can reclaim.
 */
async function seedBriefcaseWithFreeSpace(name: string): Promise<{ fileName: string; elementCount: number }> {
  const briefcase = await fixture.createBriefcase(name);
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  try {
    const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, `${name}-cat`, new SubCategoryAppearance());
    const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, `${name}-model`);

    const doomed: string[] = [];
    for (let i = 0; i < 40; i++) {
      const props: PhysicalElementProps = {
        classFullName: "Generic:PhysicalObject",
        model: modelId,
        category: categoryId,
        code: Code.createEmpty(),
        placement: { origin: [0, 0, 0], angles: {} },
        elementGeometryBuilderParams: { entryArray: boxEntries(400) },
      };
      doomed.push(db.elements.insertElement(props));
    }
    db.saveChanges();

    for (const id of doomed)
      db.elements.deleteElement(id);
    db.saveChanges();

    const reader = db.createQueryReader("SELECT COUNT(*) FROM bis.Element");
    const elementCount = Number((await reader.toArray())[0][0]);
    return { fileName: briefcase.fileName, elementCount };
  } finally {
    db.close();
  }
}

describe("imod util vacuum", () => {
  it("vacuums the iModel and reports the sizes", async () => {
    const { fileName, elementCount } = await seedBriefcaseWithFreeSpace("reclaim");
    const sizeOnDisk = statSync(fileName).size;

    const result = await runVacuum({ imodelPath: fileName });

    expect(result.bytesBefore).toBe(sizeOnDisk);
    expect(result.bytesAfter).toBe(statSync(fileName).size);
    // Strictly smaller: the seeded free pages must actually have been reclaimed,
    // otherwise this test would pass without the command doing anything.
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    // The point of the command: the file is still a usable briefcase afterwards.
    const db = await BriefcaseDb.open({ fileName, readonly: false });
    try {
      const reader = db.createQueryReader("SELECT COUNT(*) FROM bis.Element");
      expect(Number((await reader.toArray())[0][0])).toBe(elementCount);
    } finally {
      db.close();
    }
  });

  it("leaves the iModel closed so it can be vacuumed again", async () => {
    const { fileName } = await seedBriefcaseWithFreeSpace("twice");

    await runVacuum({ imodelPath: fileName });
    // A second run would throw "already open" if the first had left the file open.
    await expect(runVacuum({ imodelPath: fileName })).resolves.toBeDefined();
  });

  it("throws when the iModel file does not exist", async () => {
    await expect(runVacuum({ imodelPath: "/no/such/imodel.bim" })).rejects.toThrow(/not found/);
  });
});

describe("vacuum formatting", () => {
  it("formats byte counts", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.00 KiB");
    expect(formatBytes(1536)).toBe("1.50 KiB");
    expect(formatBytes(37588783104)).toBe("35.01 GiB");
  });

  it("formats durations", () => {
    expect(formatDuration(900)).toBe("1s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(492_000)).toBe("8m 12s");
  });
});
