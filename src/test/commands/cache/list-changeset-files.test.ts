import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { iterateChangesetGaps, recordChangesetFile, upsertChangesetMetadata } from "../../../cache/changesets";
import { runListChangesetFiles } from "../../../commands/cache/list/changeset-files";

const IMODEL = "33333333-3333-3333-3333-333333333333";
let dir: string;
let outFile: string;

/** Changesets 1..4, each with a real file unless `without` names it. */
function seed(without: number[] = []): void {
  upsertChangesetMetadata(IMODEL, [1, 2, 3, 4].map((index) => ({ index, id: `cs${index}`, fileSize: 1 })));
  for (const index of [1, 2, 3, 4]) {
    if (without.includes(index))
      continue;
    const filePath = join(dir, `cs${index}.cs`);
    writeFileSync(filePath, "x");
    recordChangesetFile(IMODEL, index, filePath);
  }
}

const lines = () => readFileSync(outFile, "utf8");

beforeEach(() => {
  getCacheDb().prepare("DELETE FROM changesets").run();
  dir = mkdtempSync(join(tmpdir(), "changeset-files-"));
  outFile = join(dir, "list.txt");
});

afterAll(() => {
  closeCacheDb();
});

describe("imod cache list changeset-files", () => {
  it("writes every file, lowest index first, as '<index> <path>'", () => {
    seed();
    // Recorded out of order, to show the order comes from the index.
    getCacheDb().prepare("UPDATE changesets SET downloaded_at = NULL").run();

    const result = runListChangesetFiles({ imodelId: IMODEL, outFile });

    expect(lines()).toBe([1, 2, 3, 4].map((i) => `${i} ${join(dir, `cs${i}.cs`)}\n`).join(""));
    expect(result).toMatchObject({ written: 4, minIndex: 1, maxIndex: 4, missingOnDisk: [] });
  });

  it("limits the list to a range", () => {
    seed();

    runListChangesetFiles({ imodelId: IMODEL, outFile, start: 2, end: 3 });

    expect(lines()).toBe(`2 ${join(dir, "cs2.cs")}\n3 ${join(dir, "cs3.cs")}\n`);
  });

  it("stops with an error naming the gaps, and writes nothing", () => {
    seed([2, 3]);

    expect(() => runListChangesetFiles({ imodelId: IMODEL, outFile })).toThrow(/no file: 2\.\.3\./);
    expect(existsSync(outFile)).toBe(false);
  });

  it("ignores gaps outside the range", () => {
    seed([1, 4]);

    expect(runListChangesetFiles({ imodelId: IMODEL, outFile, start: 2, end: 3 }).written).toBe(2);
  });

  it("counts indexes past the cached history as gaps", () => {
    seed();

    expect(() => runListChangesetFiles({ imodelId: IMODEL, outFile, start: 3, end: 9 })).toThrow(/no file: 5\.\.9\./);
  });

  it("leaves out files that are recorded but gone from disk, and reports them", () => {
    seed();
    rmSync(join(dir, "cs3.cs"));

    const result = runListChangesetFiles({ imodelId: IMODEL, outFile });

    expect(result.missingOnDisk).toEqual([3]);
    expect(lines()).not.toContain("cs3.cs");
    expect(result.written).toBe(3);
  });

  it("overwrites an existing list and leaves no temporary file", () => {
    seed();
    writeFileSync(outFile, "old contents\n");

    runListChangesetFiles({ imodelId: IMODEL, outFile, start: 4 });

    expect(lines()).toBe(`4 ${join(dir, "cs4.cs")}\n`);
    expect(existsSync(`${outFile}.tmp`)).toBe(false);
  });

  it("fails when no metadata is cached for the range", () => {
    expect(() => runListChangesetFiles({ imodelId: IMODEL, outFile })).toThrow(/No changesets cached/);
  });
});

describe("changeset gaps", () => {
  const gaps = (start?: number, end?: number) => [...iterateChangesetGaps(IMODEL, { start, end })];

  it("finds runs of changesets without files, and missing metadata", () => {
    upsertChangesetMetadata(IMODEL, [1, 2, 3, 5, 6, 8].map((index) => ({ index, id: `cs${index}`, fileSize: 1 })));
    for (const index of [1, 3, 8])
      recordChangesetFile(IMODEL, index, `/f/cs${index}.cs`);

    expect(gaps()).toEqual([{ first: 2, last: 2 }, { first: 4, last: 7 }]);
    expect(gaps(0, 10)).toEqual([
      { first: 0, last: 0 }, { first: 2, last: 2 }, { first: 4, last: 7 }, { first: 9, last: 10 },
    ]);
    expect(gaps(8)).toEqual([]);
  });
});
