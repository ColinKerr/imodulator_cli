import { createHash } from "node:crypto";
import { ByteStream, Id64 } from "@itwin/core-bentley";
import { ImdlHeader, QParams3d, QPoint3d } from "@itwin/core-common";

/**
 * Loads the iMdl parser out of core-frontend's renderer independent `common/imdl` subtree.
 *
 * Two things make this work, and both matter before touching it:
 *
 * 1. It is a deep import into another package's internals, not a public export. The
 *    core-frontend version is pinned; expect to revisit this on upgrade.
 * 2. ParseImdlDocument requires `tile/internal`, a barrel that drags in the whole tool
 *    subsystem and dies in Node on AccuDrawShortcutTool. It uses exactly one symbol from it,
 *    so a stub is seeded into require.cache first. Meshopt compression is off for the tiles
 *    generated here; if that changes the stub returns undefined and parsing fails loudly.
 */
function loadParser(): (args: unknown) => Promise<unknown> {
  const barrel = require.resolve("@itwin/core-frontend/lib/cjs/tile/internal");
  if (!require.cache[barrel]) {
    const NodeModule = require("node:module") as { new (id: string, parent: unknown): NodeJS.Module };
    const stub = new NodeModule(barrel, null) as NodeJS.Module;
    stub.filename = barrel;
    stub.loaded = true;
    stub.exports = { getMeshoptDecoder: () => undefined };
    require.cache[barrel] = stub;
  }
  return require("@itwin/core-frontend/lib/cjs/common/imdl/ParseImdlDocument").parseImdlDocument;
}

export interface TileHeaderInfo {
  valid: boolean;
  contentRange: { low: number[]; high: number[] };
  tolerance: number;
  numElementsIncluded: number;
  numElementsExcluded: number;
  flags: number;
  emptySubRanges: number;
}

/**
 * Header invariants, without decoding. Decisive in one direction: if these differ the tiles
 * are not logically equal whatever the meshes look like.
 */
export function readTileHeader(bytes: Uint8Array): TileHeaderInfo {
  const header = new ImdlHeader(ByteStream.fromUint8Array(bytes));
  const range = header.contentRange;
  return {
    valid: header.isValid,
    contentRange: {
      low: [range.low.x, range.low.y, range.low.z],
      high: [range.high.x, range.high.y, range.high.z],
    },
    tolerance: header.tolerance,
    numElementsIncluded: header.numElementsIncluded,
    numElementsExcluded: header.numElementsExcluded,
    flags: header.flags,
    emptySubRanges: header.emptySubRanges,
  };
}

/** Decimal places kept after dequantising, to drop float noise from the arithmetic. */
const DECIMAL_PLACES = 9;
const round = (n: number): number => Number(n.toFixed(DECIMAL_PLACES));

/**
 * Dequantised vertex positions of one primitive.
 *
 * Positions are the first three uint16s of each vertex's RGBA run, quantised relative to the
 * tile's own range, so two tiles holding identical geometry produce different integers
 * whenever their ranges differ at all. Comparing raw quantised values would be meaningless.
 */
function vertexPositions(vertices: any): number[][] {
  const { numVertices, numRgbaPerVertex, qparams } = vertices;
  const bytes: Uint8Array = vertices.data;
  const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const params = QParams3d.fromJSON(qparams);

  const positions: number[][] = [];
  const scratch = QPoint3d.fromScalars(0, 0, 0);
  for (let i = 0; i < numVertices; i++) {
    const base = i * numRgbaPerVertex * 2;
    scratch.setFromScalars(u16[base], u16[base + 1], u16[base + 2]);
    const point = scratch.unquantize(params);
    positions.push([round(point.x), round(point.y), round(point.z)]);
  }
  return positions;
}

/** Triangles from a 24 bit packed VertexIndices buffer. */
function triangles(indexBytes: Uint8Array): number[][] {
  const indices: number[] = [];
  for (let i = 0; i < Math.floor(indexBytes.length / 3); i++) {
    const b = i * 3;
    indices.push(indexBytes[b] | (indexBytes[b + 1] << 8) | (indexBytes[b + 2] << 16));
  }
  const out: number[][] = [];
  for (let i = 0; i + 2 < indices.length; i += 3)
    out.push([indices[i], indices[i + 1], indices[i + 2]]);
  return out;
}

interface PrimitiveDigest {
  type: string;
  digest: string;
  numVertices: number;
  numTriangles: number;
}

/**
 * Order independent digest of one primitive: each triangle becomes its three positions
 * sorted, then the triangle list itself is sorted, so two primitives holding the same
 * surface digest the same however they were emitted.
 */
function primitiveDigest(primitive: any): PrimitiveDigest {
  const params = primitive.params;
  const vertices = params?.vertices;
  if (!vertices)
    return { type: primitive.type, digest: "novertices", numVertices: 0, numTriangles: 0 };

  const positions = vertexPositions(vertices);
  // A mesh carries its indices as a bare Uint8Array on `surface`; other primitive kinds wrap
  // theirs in `{ data }`. Reading only the wrapped form silently degrades the comparison to
  // a vertex multiset, which cannot see a retriangulation of the same points.
  const indexSource: Uint8Array | undefined =
    params.surface?.indices?.data ?? params.surface?.indices ?? params.indices?.data ?? params.indices;

  let canonical: string[];
  let numTriangles = 0;
  if (indexSource) {
    const tris = triangles(indexSource).map((triangle) => {
      const points = triangle.map((i) => positions[i] ?? [NaN, NaN, NaN]);
      points.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      return points.map((p) => p.join(",")).join("|");
    });
    numTriangles = tris.length;
    tris.sort();
    canonical = tris;
  } else {
    canonical = positions.map((p) => p.join(",")).sort();
  }

  const hash = createHash("sha256");
  hash.update(`${primitive.type}\n`);
  hash.update(`planar:${params.isPlanar ? 1 : 0}\n`);
  if (vertices.uniformColor !== undefined)
    hash.update(`color:${JSON.stringify(vertices.uniformColor)}\n`);
  for (const entry of canonical) {
    hash.update(entry);
    hash.update("\n");
  }
  return { type: primitive.type, digest: hash.digest("hex"), numVertices: positions.length, numTriangles };
}

export interface DecodedFeature {
  elementId: string;
  subCategoryId: string;
  geometryClass: number;
}

/**
 * Decodes the packed feature table: three uint32 per feature, being elementId low, elementId
 * high, then (geometryClass << 24) | subCategoryIndex, with subcategory ids in a table
 * starting at numFeatures * 3.
 *
 * Comparing these is what makes a tile result meaningful. Without it the comparison checks
 * only numFeatures, so a conversion that attached the right geometry to the wrong elements
 * would still pass.
 */
function decodeFeatures(featureTable: any): DecodedFeature[] {
  const data: Uint32Array | undefined = featureTable?.data;
  const numFeatures: number = featureTable?.numFeatures ?? 0;
  if (!data || numFeatures === 0)
    return [];

  const subCategoriesOffset = numFeatures * 3;
  const features: DecodedFeature[] = [];
  for (let i = 0; i < numFeatures; i++) {
    const offset = i * 3;
    const packed = data[offset + 2];
    const subCategoryIndex = ((packed & 0x00ffffff) >>> 0) * 2 + subCategoriesOffset;
    features.push({
      elementId: Id64.fromUint32Pair(data[offset], data[offset + 1]),
      subCategoryId: Id64.fromUint32Pair(data[subCategoryIndex], data[subCategoryIndex + 1]),
      geometryClass: (packed >>> 24) & 0xff,
    });
  }
  return features;
}

export interface LogicalTile {
  header: TileHeaderInfo;
  numFeatures: number;
  features: DecodedFeature[];
  /** Primitive digests, sorted so emission order does not matter. */
  primitives: string[];
  numVertices: number;
  numTriangles: number;
  error?: string;
}

const EMPTY_TILE = { numFeatures: 0, features: [], primitives: [], numVertices: 0, numTriangles: 0 };

/** Decode a tile into an order independent form. */
export async function toLogicalTile(bytes: Uint8Array, modelId: string): Promise<LogicalTile> {
  const header = readTileHeader(bytes);
  try {
    const parse = loadParser();
    const document = (await parse({
      data: bytes,
      batchModelId: modelId,
      is3d: true,
      maxVertexTableSize: 8192,
      omitEdges: false,
      createUntransformedRootNode: false,
    })) as any;

    // parseImdlDocument returns an ImdlParseError number rather than throwing.
    if (typeof document === "number")
      return { header, ...EMPTY_TILE, error: `ImdlParseError ${document}` };

    const digests: string[] = [];
    let numVertices = 0;
    let numTriangles = 0;
    for (const node of document.nodes ?? []) {
      for (const primitive of node.primitives ?? []) {
        const digest = primitiveDigest(primitive);
        digests.push(`${digest.type}:${digest.digest}`);
        numVertices += digest.numVertices;
        numTriangles += digest.numTriangles;
      }
    }
    digests.sort();

    return {
      header,
      numFeatures: document.featureTable?.numFeatures ?? 0,
      features: decodeFeatures(document.featureTable),
      primitives: digests,
      numVertices,
      numTriangles,
    };
  } catch (err) {
    return { header, ...EMPTY_TILE, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface LogicalComparison {
  equal: boolean;
  reasons: string[];
}

function featureKeys(features: DecodedFeature[]): string[] {
  return features.map((f) => `${f.elementId}|${f.subCategoryId}|${f.geometryClass}`).sort();
}

/**
 * Compare two decoded tiles, reporting every reason they differ rather than the first:
 * "contentRange differs AND meshes differ" is a different diagnosis from either alone.
 */
export function compareLogical(a: LogicalTile, b: LogicalTile): LogicalComparison {
  const reasons: string[] = [];
  if (a.error || b.error)
    reasons.push(`decode error - source: ${a.error ?? "none"} / target: ${b.error ?? "none"}`);

  const rangeA = JSON.stringify(a.header.contentRange);
  const rangeB = JSON.stringify(b.header.contentRange);
  if (rangeA !== rangeB)
    reasons.push(`contentRange ${rangeA} -> ${rangeB}`);
  if (a.header.tolerance !== b.header.tolerance)
    reasons.push(`tolerance ${a.header.tolerance} -> ${b.header.tolerance}`);
  if (a.header.numElementsIncluded !== b.header.numElementsIncluded)
    reasons.push(`elements included ${a.header.numElementsIncluded} -> ${b.header.numElementsIncluded}`);
  if (a.header.numElementsExcluded !== b.header.numElementsExcluded)
    reasons.push(`elements excluded ${a.header.numElementsExcluded} -> ${b.header.numElementsExcluded}`);

  if (a.numFeatures !== b.numFeatures) {
    reasons.push(`features ${a.numFeatures} -> ${b.numFeatures}`);
  } else {
    const keysA = featureKeys(a.features);
    const keysB = featureKeys(b.features);
    const differing = keysA.filter((key, i) => key !== keysB[i]).length;
    if (differing > 0)
      reasons.push(`${differing} of ${keysA.length} features differ (element/subcategory/class)`);
  }

  if (a.numVertices !== b.numVertices)
    reasons.push(`vertices ${a.numVertices} -> ${b.numVertices}`);
  if (a.numTriangles !== b.numTriangles)
    reasons.push(`triangles ${a.numTriangles} -> ${b.numTriangles}`);

  if (a.primitives.length !== b.primitives.length) {
    reasons.push(`primitive count ${a.primitives.length} -> ${b.primitives.length}`);
  } else {
    const differing = a.primitives.filter((digest, i) => digest !== b.primitives[i]).length;
    if (differing > 0)
      reasons.push(`${differing} of ${a.primitives.length} primitives differ in geometry`);
  }

  return { equal: reasons.length === 0, reasons };
}
