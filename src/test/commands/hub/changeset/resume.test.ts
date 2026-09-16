import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeCacheDb, getCacheDb } from "../../../../cache/cache-db";
import { upsertChangesetMetadata } from "../../../../cache/changesets";
import { resolveStart } from "../../../../commands/hub/changeset/download-metadata";

const IMODEL = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  getCacheDb().prepare("DELETE FROM changesets").run();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  closeCacheDb();
});

function cacheUpTo(highest: number): void {
  upsertChangesetMetadata(
    IMODEL,
    Array.from({ length: highest }, (_, i) => ({ index: i + 1, id: `cs${i + 1}`, fileSize: 10 })),
  );
}

describe("resuming a metadata sync", () => {
  it("starts from the beginning when the cache holds nothing", () => {
    expect(resolveStart(IMODEL, {})).toBeUndefined();
  });

  it("resumes after the highest changeset already cached", () => {
    // A full history is hundreds of pages; without this an interrupted run starts over.
    cacheUpTo(1200);

    expect(resolveStart(IMODEL, {})).toBe(1201);
  });

  it("honours an explicit --start exactly", () => {
    cacheUpTo(1200);

    expect(resolveStart(IMODEL, { start: 5 })).toBe(5);
  });

  it("does not resume for a run that names its own range", () => {
    // A previous sub-range download must not make a later --end request skip the front of it.
    cacheUpTo(1200);

    expect(resolveStart(IMODEL, { end: 50 })).toBeUndefined();
  });

  it("fetches everything again with --refresh", () => {
    cacheUpTo(1200);

    expect(resolveStart(IMODEL, { refresh: true })).toBeUndefined();
  });

  it("keeps each iModel's resume point separate", () => {
    cacheUpTo(1200);

    expect(resolveStart("22222222-2222-2222-2222-222222222222", {})).toBeUndefined();
  });

  it("says that it is resuming rather than doing it silently", () => {
    cacheUpTo(7);
    const log = vi.spyOn(console, "log");

    resolveStart(IMODEL, {});

    expect(log.mock.calls.flat().join(" ")).toMatch(/Resuming after changeset index 7.*--refresh/);
  });
});
