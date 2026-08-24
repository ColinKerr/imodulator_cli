import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { IModelDb, SQLiteDb } from "@itwin/core-backend";
import { DbResult, OpenMode } from "@itwin/core-bentley";
import { DomainOptions, ProfileOptions, SchemaState } from "@itwin/core-common";
import { startIModelHost } from "../../host/imodel-host";
import { noopAuthClient } from "../../auth/noop-auth-client";

/**
 * The profiles stored in an iModel, by the `be_Prop` namespace that holds each one. Every
 * namespace keeps its version under the property name `SchemaVersion`.
 */
export const PROFILE_NAMESPACES = {
  be_Db: "BeSQLite",
  dgn_Db: "DgnDb",
  ec_Db: "ECDb",
} as const;

export type ProfileVersions = Record<string, string>;

/** ECSchema name to its `read.write.minor` version, as stored in `ec_Schema`. */
export type SchemaVersions = Record<string, string>;

/** One schema whose version moved during the update. */
export interface SchemaChange {
  name: string;
  /** Undefined when the schema was added by the update. */
  from?: string;
  /** Undefined when the schema is no longer present. */
  to?: string;
}

export interface UpdateProfileArgs {
  imodelPath: string;
  /** Report the profile state without writing anything. */
  dryRun?: boolean;
}

export interface UpdateProfileResult {
  /** What `IModelDb.validateSchemas` reported before any upgrade. */
  schemaState: SchemaState;
  before: ProfileVersions;
  after: ProfileVersions;
  /** Whether any profile version actually moved. */
  changed: boolean;
  schemasBefore: SchemaVersions;
  schemasAfter: SchemaVersions;
  /** Only the schemas whose version changed; unchanged schemas are not listed. */
  upgradedSchemas: SchemaChange[];
}

/**
 * Read the profile versions straight out of `be_Prop`.
 *
 * Open as plain SQLite just in case the profile is too old to open.
 */
export function readProfileVersions(imodelPath: string): ProfileVersions {
  const db = new SQLiteDb();
  const versions: ProfileVersions = {};
  db.withOpenDb({ dbName: imodelPath, openMode: OpenMode.Readonly }, () => {
    db.withSqliteStatement(
      "SELECT Namespace, StrData FROM be_Prop WHERE Name='SchemaVersion'",
      (stmt) => {
        while (stmt.step() === DbResult.BE_SQLITE_ROW) {
          const namespace = stmt.getValueString(0);
          const label = PROFILE_NAMESPACES[namespace as keyof typeof PROFILE_NAMESPACES];
          if (label)
            versions[label] = formatVersion(stmt.getValueString(1));
        }
      },
    );
  });
  return versions;
}

/**
 * Read every ECSchema's version out of `ec_Schema`.
 *
 * Read as plain SQLite for the same reason as the profile versions: this has to work on a
 * file whose profile is too old for the iModel open path to accept.
 */
export function readSchemaVersions(imodelPath: string): SchemaVersions {
  const db = new SQLiteDb();
  const versions: SchemaVersions = {};
  db.withOpenDb({ dbName: imodelPath, openMode: OpenMode.Readonly }, () => {
    db.withSqliteStatement(
      "SELECT Name, VersionDigit1, VersionDigit2, VersionDigit3 FROM ec_Schema",
      (stmt) => {
        while (stmt.step() === DbResult.BE_SQLITE_ROW) {
          const name = stmt.getValueString(0);
          versions[name] = `${stmt.getValueInteger(1)}.${stmt.getValueInteger(2)}.${stmt.getValueInteger(3)}`;
        }
      },
    );
  });
  return versions;
}

/** The schemas whose version moved, newly added ones included. Unchanged schemas are omitted. */
export function findUpgradedSchemas(before: SchemaVersions, after: SchemaVersions): SchemaChange[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: SchemaChange[] = [];
  for (const name of names) {
    if (before[name] !== after[name])
      changes.push({ name, from: before[name], to: after[name] });
  }
  return changes;
}

/** A line per upgraded schema. */
export function formatSchemaChanges(changes: SchemaChange[]): string {
  return changes
    .map(({ name, from, to }) => `  ${name}: ${from ?? "(added)"} -> ${to ?? "(removed)"}`)
    .join("\n");
}

/** `{"major":4,"minor":0,"sub1":0,"sub2":5}` reads better as `4.0.0.5`. */
function formatVersion(strData: string): string {
  try {
    const v = JSON.parse(strData) as { major: number; minor: number; sub1: number; sub2: number };
    return `${v.major}.${v.minor}.${v.sub1}.${v.sub2}`;
  } catch {
    return strData;
  }
}

/** A line per profile, marking the ones that moved. */
export function formatProfileChange(before: ProfileVersions, after: ProfileVersions): string {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names
    .map((name) => {
      const from = before[name] ?? "(absent)";
      const to = after[name] ?? "(absent)";
      return from === to ? `  ${name}: ${from}` : `  ${name}: ${from} -> ${to}`;
    })
    .join("\n");
}

export async function runUpdateProfile(args: UpdateProfileArgs): Promise<UpdateProfileResult> {
  if (!fs.existsSync(args.imodelPath))
    throw new Error(`iModel file not found: ${args.imodelPath}`);

  await startIModelHost(noopAuthClient);

  const before = readProfileVersions(args.imodelPath);
  const schemasBefore = readSchemaVersions(args.imodelPath);
  const schemaState = IModelDb.validateSchemas(args.imodelPath, true);

  console.log(`Profile versions:\n${formatProfileChange(before, before)}`);
  console.log(`Schema state: ${SchemaState[schemaState]} (${Object.keys(schemasBefore).length} schema(s))`);

  // A file written by a newer iTwin.js than this one cannot be upgraded, only damaged.
  if (schemaState === SchemaState.TooNew)
    throw new Error(
      "This iModel was written by a newer version of iTwin.js than this tool uses; it cannot be upgraded here.",
    );

  if (args.dryRun) {
    console.log("Dry run: nothing was written.");
    return {
      schemaState,
      before,
      after: before,
      changed: false,
      schemasBefore,
      schemasAfter: schemasBefore,
      upgradedSchemas: [],
    };
  }

  const nativeDb = IModelDb.openDgnDb({ path: args.imodelPath }, OpenMode.ReadWrite, {
    profile: ProfileOptions.Upgrade,
    schemaLockHeld: true, domain: DomainOptions.Upgrade,
  });
  try {
    nativeDb.saveChanges();
  } finally {
    nativeDb.closeFile();
  }

  const after = readProfileVersions(args.imodelPath);
  const schemasAfter = readSchemaVersions(args.imodelPath);
  const upgradedSchemas = findUpgradedSchemas(schemasBefore, schemasAfter);
  const changed = JSON.stringify(before) !== JSON.stringify(after);

  console.log(changed ? `Profile updated:\n${formatProfileChange(before, after)}` : "Profile was already up to date.");
  console.log(
    upgradedSchemas.length > 0
      ? `Schemas upgraded (${upgradedSchemas.length}):\n${formatSchemaChanges(upgradedSchemas)}`
      : "No schemas were upgraded.",
  );

  return { schemaState, before, after, changed, schemasBefore, schemasAfter, upgradedSchemas };
}

export const updateProfileCommand: CommandModule<unknown, UpdateProfileArgs> = {
  command: "update-profile",
  describe: "Update an iModel's profile to the latest supported by iTwin.js",
  builder: (y) =>
    y
      .option("imodel-path", {
        type: "string",
        demandOption: true,
        describe: "Path to the local iModel file",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "Report the current profile versions and schema state, without writing",
      }) as never,
  handler: async (argv) => {
    await runUpdateProfile({ imodelPath: argv.imodelPath, dryRun: argv.dryRun });
  },
};
