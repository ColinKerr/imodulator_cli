import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BriefcaseDb, PhysicalModel, SpatialCategory } from "@itwin/core-backend";
import { Code, IModel, SubCategoryAppearance, type PhysicalElementProps } from "@itwin/core-common";
import { readChunk, type RowCursor } from "../../../web/src/paging";
import { closeCacheDb } from "../../cache/cache-db";
import { HubMockFixture } from "../hub-mock-fixture";

const fixture = new HubMockFixture();
let cacheDir: string;
let fileName: string;
/** More rows than one chunk, so paging has to happen more than once. */
const SEEDED = 25;

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "imod-paging-cache-"));
  process.env.IMOD_CACHE_DIR = cacheDir;
  await fixture.startup("paging");
  const briefcase = await fixture.createBriefcase("paged");
  fileName = briefcase.fileName;

  const db = await BriefcaseDb.open({ fileName, readonly: false });
  try {
    const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, "cat", new SubCategoryAppearance());
    const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, "model");
    for (let i = 0; i < SEEDED; i++) {
      const props: PhysicalElementProps = {
        classFullName: "Generic:PhysicalObject",
        model: modelId,
        category: categoryId,
        code: Code.createEmpty(),
        userLabel: `element-${String(i).padStart(3, "0")}`,
        placement: { origin: [i, 0, 0], angles: {} },
      };
      db.elements.insertElement(props);
    }
    db.saveChanges();
  } finally {
    db.close();
  }
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
  rmSync(cacheDir, { recursive: true, force: true });
});

const QUERY = "SELECT UserLabel FROM Generic.PhysicalObject ORDER BY UserLabel";

async function withReader<T>(fn: (cursor: RowCursor) => Promise<T>): Promise<T> {
  const db = await BriefcaseDb.open({ fileName, readonly: true });
  try {
    // The same ECSqlReader the console's frontend drives, over the same query API.
    return await fn(db.createQueryReader(QUERY) as unknown as RowCursor);
  } finally {
    db.close();
  }
}

describe("readChunk", () => {
  it("resumes where the previous chunk stopped, never repeating or skipping a row", async () => {
    const labels = await withReader(async (cursor) => {
      const first = await readChunk(cursor, 10);
      const second = await readChunk(cursor, 10);
      const third = await readChunk(cursor, 10);

      expect(first.rows).toHaveLength(10);
      expect(first.done).toBe(false);
      expect(second.rows).toHaveLength(10);
      expect(second.done).toBe(false);
      // The last chunk is short, and reports the query as spent.
      expect(third.rows).toHaveLength(SEEDED - 20);
      expect(third.done).toBe(true);

      return [...first.rows, ...second.rows, ...third.rows].map((row) => row[0] as string);
    });

    expect(labels).toHaveLength(SEEDED);
    expect(new Set(labels).size).toBe(SEEDED);
    // Ordered by the query, so paging preserved the order across chunk boundaries.
    expect(labels).toEqual([...labels].sort());
  });

  it("keeps returning nothing once the query is spent", async () => {
    await withReader(async (cursor) => {
      await readChunk(cursor, SEEDED);
      const after = await readChunk(cursor, 10);
      expect(after).toEqual({ rows: [], done: true });
    });
  });

  it("reads the whole result when asked for more than there is", async () => {
    await withReader(async (cursor) => {
      const chunk = await readChunk(cursor, 1000);
      expect(chunk.rows).toHaveLength(SEEDED);
      expect(chunk.done).toBe(true);
    });
  });

  it("stops at the requested count without over-reading", async () => {
    const stub = (): RowCursor => {
      let index = 0;
      return {
        step: async () => { index++; return index <= 100; },
        get current() { return { toArray: () => [index] }; },
      };
    };
    const cursor = stub();
    const chunk = await readChunk(cursor, 3);
    expect(chunk).toEqual({ rows: [[1], [2], [3]], done: false });
    // The cursor is left positioned for the next chunk, not consumed further.
    expect((await readChunk(cursor, 2)).rows).toEqual([[4], [5]]);
  });
});
