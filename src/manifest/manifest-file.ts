/**
 * Reader for the Cloud Backed SQLite `manifest.bcv` file.
 *
 * The format is an ad-hoc big-endian binary layout. These offsets come from the parser
 * itself -- `bcvManifestParse` in iModelCore/BeSQLite/SQLite/bcvutil.c
 * See plan/commands/hub/MANIFEST_LIST.md.
 */

/** The only manifest version this reader understands. */
export const MANIFEST_VERSION = 4;
/** Bytes of manifest header before the first database header. */
export const MANIFEST_HEADER_BYTES = 24;
/** Bytes in each per-database header. */
export const MANIFEST_DB_HEADER_BYTES = 152;
/** Bytes reserved for a database's display name, zero padded. */
export const MANIFEST_DB_NAME_BYTES = 128;

/** Block ids are between 12 and 32 bytes (BCV_MIN_NAMEBYTES / BCV_MAX_NAMEBYTES). */
const MIN_NAME_SIZE = 12;
const MAX_NAME_SIZE = 32;

/** High bit of a database's block count marks the database as deleted. */
const DELETED_FLAG = 0x80000000;

export interface ManifestDbInfo {
  /** Database id, 1 or greater. */
  id: number;
  /** Id of the database this one was copied from, or 0 when it has no parent. */
  parentId: number;
  version: number;
  /** Number of blocks making up the database. */
  blockCount: number;
  /** Offset of this database's block array within the manifest. */
  blockArrayOffset: number;
  /**
   * Entries stored in the block array. Only meaningful for a database with a parent, where
   * it counts the blocks that differ from it; a database with no parent stores its ids
   * packed and leaves this 0.
   */
  blockArrayEntries: number;
  name: string;
  deleted: boolean;
}

export interface ManifestInfo {
  version: number;
  /** Size of each block in bytes. */
  blockSize: number;
  /** Size of a block id in bytes. */
  nameSize: number;
  /** Largest database id assigned so far. */
  maxDbId: number;
  /** Number of blocks on the delete list, which belong to no database. */
  deleteEntryCount: number;
  databases: ManifestDbInfo[];
}

/**
 * Parse a `manifest.bcv` file.
 *
 * Only the fixed-size headers are read; the block arrays are left alone, so this covers
 * the whole file description without walking every block id.
 *
 * @throws if the buffer is not a version 4 manifest, or is too short for what it declares.
 */
export function parseManifest(data: Buffer): ManifestInfo {
  if (data.length < MANIFEST_HEADER_BYTES)
    throw new Error(
      `Not a manifest file: expected at least ${MANIFEST_HEADER_BYTES} bytes, got ${data.length}.`,
    );

  const version = data.readUInt32BE(0);
  if (version !== MANIFEST_VERSION)
    throw new Error(`Unsupported manifest version ${version}; only version ${MANIFEST_VERSION} is supported.`);

  const blockSize = data.readUInt32BE(4);
  const databaseCount = data.readUInt32BE(8);
  const deleteEntryCount = data.readUInt32BE(12);
  const nameSize = data.readUInt32BE(16);
  const maxDbId = data.readUInt32BE(20);

  if (nameSize < MIN_NAME_SIZE || nameSize > MAX_NAME_SIZE)
    throw new Error(
      `Manifest is corrupt: block id size ${nameSize} is outside the supported range ${MIN_NAME_SIZE}-${MAX_NAME_SIZE}.`,
    );

  const headersEnd = MANIFEST_HEADER_BYTES + MANIFEST_DB_HEADER_BYTES * databaseCount;
  if (data.length < headersEnd)
    throw new Error(
      `Manifest is truncated: ${databaseCount} database header(s) need ${headersEnd} bytes, file is ${data.length}.`,
    );

  const databases: ManifestDbInfo[] = [];
  for (let i = 0; i < databaseCount; i++) {
    const at = MANIFEST_HEADER_BYTES + MANIFEST_DB_HEADER_BYTES * i;
    const rawBlockCount = data.readUInt32BE(at + 16);
    databases.push({
      id: data.readUInt32BE(at + 0),
      parentId: data.readUInt32BE(at + 4),
      version: data.readUInt32BE(at + 8),
      blockArrayOffset: data.readUInt32BE(at + 12),
      blockCount: rawBlockCount & ~DELETED_FLAG,
      deleted: (rawBlockCount & DELETED_FLAG) !== 0,
      blockArrayEntries: data.readUInt32BE(at + 20),
      name: readName(data, at + 24),
    });
  }

  return { version, blockSize, nameSize, maxDbId, deleteEntryCount, databases };
}

/** Database names are zero padded to a fixed width. */
function readName(data: Buffer, at: number): string {
  const field = data.subarray(at, at + MANIFEST_DB_NAME_BYTES);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}
