import * as fs from "node:fs";
import * as path from "node:path";
import { BisCoreSchema, IModelDb, SQLiteDb } from "@itwin/core-backend";
import { DbResult, OpenMode } from "@itwin/core-bentley";

/**
 * A GeometryPart that keeps DefinitionElement as its base class inherits IsPrivate, and ECDb
 * resolves an inherited property through the class that declares it -- so every query
 * touching IsPrivate joins bis_DefinitionElement no matter what GeometryPart's own property
 * map says. Declaring the property on GeometryPart as an override makes that map the one
 * ECDb consults, which is what lets the geometry, and then the rows, leave that table.
 */
const OVERRIDE_PROPERTY =
  `<ECProperty propertyName="IsPrivate" typeName="boolean" displayLabel="Is Private" ` +
  `description="If true, this bis:DefinitionElement should not be displayed in the GUI."/>`;

const BASE_CLASS = "<BaseClass>DefinitionElement</BaseClass>";

export interface OverrideSchema {
  filePath: string;
  version: string;
}

function readBisCoreVersion(imodelPath: string): [number, number, number] {
  const db = new SQLiteDb();
  let version: [number, number, number] = [1, 0, 0];
  db.withOpenDb({ dbName: imodelPath, openMode: OpenMode.Readonly }, () => {
    db.withSqliteStatement(
      "SELECT VersionDigit1, VersionDigit2, VersionDigit3 FROM ec_Schema WHERE Name='BisCore'",
      (stmt) => {
        if (stmt.step() === DbResult.BE_SQLITE_ROW)
          version = [stmt.getValueInteger(0), stmt.getValueInteger(1), stmt.getValueInteger(2)];
      },
    );
  });
  return version;
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/**
 * BisCore as the installed iTwin.js ships it, with the IsPrivate override added to
 * GeometryPart and the minor version raised past whatever the iModel already carries.
 *
 * Derived from the shipped schema rather than hand maintained, so an addon upgrade carries
 * its new baseline with the same edit applied.
 */
export function buildIsPrivateOverrideSchema(imodelPath: string, outDir: string): OverrideSchema {
  const source = fs.readFileSync(BisCoreSchema.schemaFilePath, "utf8");
  const shipped = /schemaName="BisCore"\s+alias="bis"\s+version="([\d.]+)"/.exec(source);
  if (!shipped)
    throw new Error("Could not read the shipped BisCore version.");

  const [shippedRead, shippedWrite, shippedMinor] = shipped[1].split(".").map(Number);
  const [fileRead, fileWrite, fileMinor] = readBisCoreVersion(imodelPath);
  if (fileRead !== shippedRead || fileWrite !== shippedWrite)
    throw new Error(
      `This iModel carries BisCore ${fileRead}.${fileWrite}.${fileMinor}, which the installed iTwin.js (${shipped[1]}) cannot upgrade.`,
    );

  const version = `${pad(shippedRead, 2)}.${pad(shippedWrite, 2)}.${3002}`;
  let out = source.replace(
    `schemaName="BisCore" alias="bis" version="${shipped[1]}"`,
    `schemaName="BisCore" alias="bis" version="${version}"`,
  );

  const start = out.indexOf('<ECEntityClass typeName="GeometryPart"');
  if (start < 0)
    throw new Error("GeometryPart class not found in the shipped BisCore.");
  const end = out.indexOf("</ECEntityClass>", start);
  const block = out.slice(start, end);
  const patched = block.replace(BASE_CLASS, `${BASE_CLASS}\n        ${OVERRIDE_PROPERTY}`);
  if (patched === block)
    throw new Error("GeometryPart does not derive from DefinitionElement in the shipped BisCore.");
  out = out.slice(0, start) + patched + out.slice(end);

  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, "BisCore.ecschema.xml");
  fs.writeFileSync(filePath, out);
  return { filePath, version };
}

/**
 * Import a schema straight through the native layer.
 *
 * The converted file is a copy that is never pushed as a changeset, so there is no lock to
 * take and no hub to take it from; this is the same route the profile upgrade uses.
 */
export function importSchemaFile(imodelPath: string, schemaPath: string): void {
  const nativeDb = IModelDb.openDgnDb({ path: imodelPath }, OpenMode.ReadWrite);
  try {
    nativeDb.importSchemas([schemaPath], { schemaLockHeld: true });
    nativeDb.saveChanges();
  } finally {
    nativeDb.closeFile();
  }
}
