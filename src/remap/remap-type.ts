/** The mapping change applied by `imod util mapipulate`. */
export type RemapType = 3000 | 3001 | 3002;

export const REMAP_TYPES: readonly RemapType[] = [3000, 3001, 3002];

export interface RemapProfile {
  type: RemapType;
  /** Table the new bis_GeometryPart table is joined to. */
  parentTable: "bis_Element" | "bis_DefinitionElement";
  /** Reparent GeometryPart to InformationContentElement. Only 3000 changes the schema. */
  reparent: boolean;
  /**
   * Import a BisCore that declares IsPrivate on GeometryPart. Without the override the class
   * inherits that property from DefinitionElement, and ECDb resolves an inherited property
   * through its declaring class -- so the bis_DefinitionElement row can never be released.
   */
  overrideIsPrivate: boolean;
  /**
   * Keep the bis_DefinitionElement rows with their geometry columns nulled, making
   * GeometryPart a three level joined class. Deleting them instead is what removes
   * GeometryParts from polymorphic queries over bis.DefinitionElement.
   */
  keepDefinitionRows: boolean;
  /** [major, minor, sub1, sub2] for ec_Db and dgn_Db, or undefined to leave them alone. */
  ecDbVersion?: readonly [number, number, number, number];
  dgnDbVersion?: readonly [number, number, number, number];
  /** Value written to BisCore's VersionDigit3, recording what was done to the file. */
  bisCoreDigit3: number;
  /** GeometryPart property maps expected to remain on bis_DefinitionElement afterwards. */
  definitionElementMaps: readonly string[];
  /** GeometryPart property maps expected on bis_GeometryPart afterwards. */
  newTableMaps: number;
  /** Whether GeometryParts still answer polymorphic bis.DefinitionElement queries. */
  keepsPolymorphicDefinitionElement: boolean;
}

const PROFILES: Record<RemapType, RemapProfile> = {
  3000: {
    type: 3000,
    parentTable: "bis_Element",
    reparent: true,
    overrideIsPrivate: false,
    keepDefinitionRows: false,
    bisCoreDigit3: 3000,
    definitionElementMaps: [],
    newTableMaps: 9,
    keepsPolymorphicDefinitionElement: false,
  },
  3001: {
    type: 3001,
    parentTable: "bis_DefinitionElement",
    reparent: false,
    overrideIsPrivate: false,
    keepDefinitionRows: true,
    ecDbVersion: [4, 0, 3001, 0],
    dgnDbVersion: [2, 0, 3001, 0],
    bisCoreDigit3: 3001,
    definitionElementMaps: ["ECClassId", "ECInstanceId", "IsPrivate"],
    newTableMaps: 9,
    keepsPolymorphicDefinitionElement: true,
  },
  3002: {
    type: 3002,
    parentTable: "bis_Element",
    reparent: false,
    // GeometryPart keeps DefinitionElement as its base class, so IsPrivate comes with it and
    // moves into the new table alongside the geometry.
    overrideIsPrivate: true,
    keepDefinitionRows: false,
    ecDbVersion: [4, 0, 3002, 0],
    dgnDbVersion: [2, 0, 3002, 0],
    bisCoreDigit3: 3002,
    definitionElementMaps: [],
    newTableMaps: 10,
    keepsPolymorphicDefinitionElement: false,
  },
};

export function remapProfile(type: RemapType): RemapProfile {
  const profile = PROFILES[type];
  if (!profile)
    throw new Error(`Unknown remap type: ${type}. Expected one of ${REMAP_TYPES.join(", ")}.`);
  return profile;
}

/** `<name>_im3001.bim` for a source of `<name>.bim`. */
export function remapOutputPath(imodelPath: string, type: RemapType): string {
  const suffix = `_im${type}`;
  return imodelPath.endsWith(".bim")
    ? `${imodelPath.slice(0, -".bim".length)}${suffix}.bim`
    : `${imodelPath}${suffix}`;
}
