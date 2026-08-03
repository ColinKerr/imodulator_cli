import { describe, expect, it } from "vitest";
import {
  MANIFEST_DB_HEADER_BYTES,
  MANIFEST_DB_NAME_BYTES,
  MANIFEST_HEADER_BYTES,
  MANIFEST_VERSION,
  parseManifest,
} from "../../manifest/manifest-file";

interface FakeDb {
  id: number;
  parentId?: number;
  version?: number;
  blockArrayOffset?: number;
  blockCount: number;
  blockArrayEntries?: number;
  name: string;
  deleted?: boolean;
}

/**
 * Build a version 4 manifest, matching the layout bcvManifestParse reads: a 24 byte
 * big-endian header followed by a 152 byte header per database.
 */
function buildManifest(options: {
  version?: number;
  blockSize?: number;
  nameSize?: number;
  maxDbId?: number;
  deleteEntryCount?: number;
  databases?: FakeDb[];
  truncateTo?: number;
}): Buffer {
  const databases = options.databases ?? [];
  const data = Buffer.alloc(MANIFEST_HEADER_BYTES + MANIFEST_DB_HEADER_BYTES * databases.length);

  data.writeUInt32BE(options.version ?? MANIFEST_VERSION, 0);
  data.writeUInt32BE(options.blockSize ?? 4 * 1024 * 1024, 4);
  data.writeUInt32BE(databases.length, 8);
  data.writeUInt32BE(options.deleteEntryCount ?? 0, 12);
  data.writeUInt32BE(options.nameSize ?? 16, 16);
  data.writeUInt32BE(options.maxDbId ?? databases.length, 20);

  databases.forEach((db, i) => {
    const at = MANIFEST_HEADER_BYTES + MANIFEST_DB_HEADER_BYTES * i;
    data.writeUInt32BE(db.id, at + 0);
    data.writeUInt32BE(db.parentId ?? 0, at + 4);
    data.writeUInt32BE(db.version ?? 1, at + 8);
    data.writeUInt32BE(db.blockArrayOffset ?? 0, at + 12);
    // The high bit of the block count is the deleted flag. `>>> 0` keeps it unsigned:
    // JS bitwise ops yield a signed int32, which writeUInt32BE rejects.
    data.writeUInt32BE(db.deleted ? (db.blockCount | 0x80000000) >>> 0 : db.blockCount, at + 16);
    data.writeUInt32BE(db.blockArrayEntries ?? db.blockCount, at + 20);
    data.write(db.name, at + 24, MANIFEST_DB_NAME_BYTES, "utf8"); // zero padded by alloc
  });

  return options.truncateTo === undefined ? data : data.subarray(0, options.truncateTo);
}

describe("parseManifest", () => {
  it("reads the manifest header", () => {
    const manifest = parseManifest(
      buildManifest({ blockSize: 1 << 20, nameSize: 20, maxDbId: 7, deleteEntryCount: 3 }),
    );
    expect(manifest).toMatchObject({
      version: 4,
      blockSize: 1 << 20,
      nameSize: 20,
      maxDbId: 7,
      deleteEntryCount: 3,
      databases: [],
    });
  });

  it("reads every database header", () => {
    const manifest = parseManifest(
      buildManifest({
        databases: [
          { id: 1, blockCount: 8929, name: "44444444-4444-4444-4444-444444444444.bim" },
          { id: 2, parentId: 1, version: 3, blockCount: 12, blockArrayEntries: 4, blockArrayOffset: 4096, name: "child.bim" },
        ],
      }),
    );

    expect(manifest.databases).toHaveLength(2);
    expect(manifest.databases[0]).toMatchObject({
      id: 1,
      parentId: 0,
      blockCount: 8929,
      name: "44444444-4444-4444-4444-444444444444.bim",
      deleted: false,
    });
    // A child stores only the blocks that differ from its parent.
    expect(manifest.databases[1]).toMatchObject({
      id: 2,
      parentId: 1,
      version: 3,
      blockCount: 12,
      blockArrayEntries: 4,
      blockArrayOffset: 4096,
    });
  });

  it("unpacks the deleted flag from the block count", () => {
    const [db] = parseManifest(
      buildManifest({ databases: [{ id: 1, blockCount: 42, name: "gone.bim", deleted: true }] }),
    ).databases;
    expect(db.deleted).toBe(true);
    // Without masking the flag off, the count would be a nonsense 2147483690.
    expect(db.blockCount).toBe(42);
  });

  it("trims the zero padding from database names", () => {
    const [db] = parseManifest(
      buildManifest({ databases: [{ id: 1, blockCount: 1, name: "short.bim" }] }),
    ).databases;
    expect(db.name).toBe("short.bim");
  });

  it("rejects a manifest whose version it does not understand", () => {
    expect(() => parseManifest(buildManifest({ version: 3 }))).toThrow(/version 3/);
    expect(() => parseManifest(buildManifest({ version: 5 }))).toThrow(/only version 4/);
  });

  it("rejects a buffer too short to be a manifest", () => {
    expect(() => parseManifest(Buffer.alloc(8))).toThrow(/at least 24 bytes/);
  });

  it("rejects a manifest truncated part way through its database headers", () => {
    const truncated = buildManifest({
      databases: [
        { id: 1, blockCount: 1, name: "a.bim" },
        { id: 2, blockCount: 1, name: "b.bim" },
      ],
      truncateTo: MANIFEST_HEADER_BYTES + MANIFEST_DB_HEADER_BYTES,
    });
    expect(() => parseManifest(truncated)).toThrow(/truncated/);
  });

  it("rejects a block id size outside the supported range", () => {
    expect(() => parseManifest(buildManifest({ nameSize: 8 }))).toThrow(/outside the supported range/);
    expect(() => parseManifest(buildManifest({ nameSize: 64 }))).toThrow(/outside the supported range/);
  });
});
