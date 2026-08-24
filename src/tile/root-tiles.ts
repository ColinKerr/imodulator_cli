import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { IModelDb } from "@itwin/core-backend";
import { BatchType, defaultTileOptions, iModelTileTreeIdToString } from "@itwin/core-common";
import { openReadonly } from "../host/open-imodel";
import { compareLogical, toLogicalTile, type LogicalTile } from "./imdl-logical";

/**
 * Tiles are cached in a `<file>.Tiles` sidecar keyed by tile tree and content id, and that
 * key does not change when the iModel underneath is rewritten. Comparing a converted iModel
 * against tiles cached before the conversion measures nothing, so the sidecar is discarded
 * before generating. It is a cache; deleting it only costs the time to rebuild it.
 */
function discardTileCache(fileName: string): void {
  fs.rmSync(`${fileName}.Tiles`, { force: true });
}

export interface RootTile {
  modelId: string;
  treeId: string;
  contentId: string;
  bytes: number;
  /** sha256 of the raw tile content. */
  digest: string;
  error?: string;
}

export interface TileComparison {
  modelId: string;
  /** Byte identical, which is the expected result for a metadata only conversion. */
  same: boolean;
  /** Bytes differ but the tiles are logically equal. */
  logicallySame: boolean;
  /**
   * The source does not reproduce its own tile, so the two files cannot be compared here.
   * Not a difference the conversion caused, and not evidence that it caused none.
   */
  nondeterministic?: boolean;
  reason?: string;
}

/** Extra generations used to decide whether a differing tile is simply not reproducible. */
const DETERMINISM_REPEATS = 3;

/**
 * The primary tile tree for a model, with edges, at default options. These are the same
 * internal APIs the display system calls, so this measures the bytes a viewer would receive.
 */
function primaryTreeId(modelId: string): string {
  return iModelTileTreeIdToString(
    modelId,
    { type: BatchType.Primary, edges: defaultTileOptions.edgeOptions },
    defaultTileOptions,
  );
}

/** Geometric models that actually have geometry, in a stable order. */
export async function listGeometricModels(db: IModelDb, limit: number): Promise<string[]> {
  const modelIds: string[] = [];
  const reader = db.createQueryReader(
    `SELECT DISTINCT Model.Id FROM bis.GeometricElement3d
     WHERE GeometryStream IS NOT NULL ORDER BY Model.Id LIMIT ${limit}`,
  );
  for await (const row of reader)
    modelIds.push(row[0] as string);
  return modelIds;
}

/**
 * Root tile of each model's primary tree. Root tiles are the right unit: every model has
 * exactly one, it is deterministic, and its content is a function of the whole model's
 * geometry, so a relocation that corrupts geometry shows up immediately.
 *
 * Tiles are generated on demand, so this is the slowest part of validation by far.
 */
export async function scanRootTiles(fileName: string, modelLimit: number): Promise<RootTile[]> {
  discardTileCache(fileName);
  const db = openReadonly(fileName, `tiles-${process.pid}-${fileName}`);
  try {
    const tiles: RootTile[] = [];
    const modelIds = await listGeometricModels(db, modelLimit);
    for (const modelId of modelIds) {
      const treeId = primaryTreeId(modelId);
      try {
        const props = await db.tiles.requestTileTreeProps(treeId);
        const contentId = props.rootTile.contentId;
        const content = await db.tiles.getTileContent(treeId, contentId);
        tiles.push({
          modelId,
          treeId,
          contentId,
          bytes: content.byteLength,
          digest: createHash("sha256").update(content).digest("hex"),
        });
      } catch (err) {
        tiles.push({
          modelId,
          treeId,
          contentId: "",
          bytes: 0,
          digest: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return tiles;
  } finally {
    db.close();
  }
}

/** Generate one tile again from scratch, returning its digest. */
async function regenerateDigest(fileName: string, tile: RootTile): Promise<string> {
  discardTileCache(fileName);
  const db = openReadonly(fileName, `regen-${process.pid}-${Math.random()}-${fileName}`);
  try {
    const content = await db.tiles.getTileContent(tile.treeId, tile.contentId);
    return createHash("sha256").update(content).digest("hex");
  } finally {
    db.close();
  }
}

/**
 * The digests one file produces for one tile across repeated fresh generations.
 *
 * Faceting a BRep is not reproducible run to run on every model, so a tile can differ from
 * itself. Without this, such a model reports as a conversion failure forever.
 */
async function digestSet(fileName: string, tile: RootTile): Promise<Set<string>> {
  const digests = new Set([tile.digest]);
  for (let i = 0; i < DETERMINISM_REPEATS; i++)
    digests.add(await regenerateDigest(fileName, tile));
  return digests;
}

/** Fetch one tile's content again, for the logical decode. */
async function tileContent(fileName: string, tile: RootTile): Promise<Uint8Array> {
  const db = openReadonly(fileName, `tile-${process.pid}-${tile.modelId}-${fileName}`);
  try {
    return await db.tiles.getTileContent(tile.treeId, tile.contentId);
  } finally {
    db.close();
  }
}

/**
 * Compare root tiles. Byte identity is the expected result, so the logical decode only runs
 * to adjudicate tiles whose bytes differ.
 */
export async function compareRootTiles(
  sourcePath: string,
  targetPath: string,
  source: RootTile[],
  target: RootTile[],
): Promise<TileComparison[]> {
  const byModel = new Map(target.map((tile) => [tile.modelId, tile]));
  const comparisons: TileComparison[] = [];

  for (const a of source) {
    const b = byModel.get(a.modelId);
    if (!b) {
      comparisons.push({
        modelId: a.modelId,
        same: false,
        logicallySame: false,
        reason: "no matching tile in the converted iModel",
      });
      continue;
    }

    if (a.error || b.error) {
      comparisons.push({
        modelId: a.modelId,
        same: false,
        logicallySame: false,
        reason: `tile error - source: ${a.error ?? "none"} / target: ${b.error ?? "none"}`,
      });
      continue;
    }

    if (a.digest === b.digest) {
      comparisons.push({ modelId: a.modelId, same: true, logicallySame: false });
      continue;
    }

    // Bytes differ. Before calling that a difference, check the source reproduces itself:
    // if the target's results are all ones the source also produces on its own, the two
    // files are indistinguishable here.
    const sourceDigests = await digestSet(sourcePath, a);
    const targetDigests = await digestSet(targetPath, b);
    if ([...targetDigests].every((digest) => sourceDigests.has(digest))) {
      comparisons.push({
        modelId: a.modelId,
        same: false,
        logicallySame: false,
        nondeterministic: true,
        reason:
          `tile generation is not reproducible for this model - the source alone produced ` +
          `${sourceDigests.size} different tiles in ${DETERMINISM_REPEATS + 1} generations, and every ` +
          `result from the converted iModel is one of them`,
      });
      continue;
    }

    let logicalA: LogicalTile | undefined;
    let logicalB: LogicalTile | undefined;
    try {
      logicalA = await toLogicalTile(await tileContent(sourcePath, a), a.modelId);
      logicalB = await toLogicalTile(await tileContent(targetPath, b), b.modelId);
    } catch (err) {
      comparisons.push({
        modelId: a.modelId,
        same: false,
        logicallySame: false,
        reason: `bytes differ (${a.bytes} -> ${b.bytes}); could not decode: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const comparison = compareLogical(logicalA, logicalB);
    comparisons.push({
      modelId: a.modelId,
      same: false,
      logicallySame: comparison.equal,
      reason: comparison.equal
        ? `bytes differ, logically equal (${logicalA.numTriangles} triangles, ${logicalA.primitives.length} primitives)`
        : comparison.reasons.join("; "),
    });
  }

  return comparisons;
}

export function countDifferingTiles(comparisons: TileComparison[]): number {
  return comparisons.filter((c) => !c.same && !c.logicallySame && !c.nondeterministic).length;
}

export function formatTileComparisons(comparisons: TileComparison[]): string {
  const identical = comparisons.filter((c) => c.same).length;
  const logical = comparisons.filter((c) => !c.same && c.logicallySame).length;
  const nondeterministic = comparisons.filter((c) => c.nondeterministic).length;
  const different = countDifferingTiles(comparisons);

  const lines = comparisons.map((c) => {
    const tag = c.same ? "same" : c.logicallySame ? "~log" : c.nondeterministic ? "nondet" : "DIFF";
    return `    ${tag.padEnd(6)}  model ${c.modelId}${c.reason ? `  ${c.reason}` : ""}`;
  });
  lines.push(
    `    ${identical}/${comparisons.length} byte-identical, ${logical} logically equal, ` +
      `${nondeterministic} not reproducible, ${different} different`,
  );
  return lines.join("\n");
}
