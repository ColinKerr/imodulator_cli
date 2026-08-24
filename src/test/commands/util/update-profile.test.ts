import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { SchemaState } from "@itwin/core-common";
import {
  findUpgradedSchemas,
  formatProfileChange,
  formatSchemaChanges,
  PROFILE_NAMESPACES,
  readProfileVersions,
  readSchemaVersions,
  runUpdateProfile,
} from "../../../commands/util/update-profile";
import { HubMockFixture } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();

beforeAll(async () => {
  await fixture.startup("update-profile");
});

afterAll(async () => {
  await fixture.shutdown();
});

/**
 * Note what these tests cannot cover: a briefcase created by the current iTwin.js already
 * has the current profile, so there is no supported way to stage a file that genuinely
 * needs upgrading. The "profile actually moves" path is therefore unverified here -- it
 * needs an iModel written by an older iTwin.js. What is covered is that the command is a
 * correct no-op on a current file, which is the case that would otherwise silently corrupt
 * one.
 */
describe("readProfileVersions", () => {
  it("reads a version for each known profile namespace", async () => {
    const briefcase = await fixture.createBriefcase("read-versions");
    const versions = readProfileVersions(briefcase.fileName);

    for (const label of Object.values(PROFILE_NAMESPACES)) {
      expect(versions[label], `expected a ${label} profile version`).toBeDefined();
      expect(versions[label]).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });
});

describe("formatProfileChange", () => {
  it("lists a profile that did not move as just its version", () => {
    const same = { ECDb: "4.0.0.5" };
    expect(formatProfileChange(same, same)).toBe("  ECDb: 4.0.0.5");
  });

  it("shows the transition for profiles that moved", () => {
    const out = formatProfileChange({ ECDb: "4.0.0.4" }, { ECDb: "4.0.0.5" });
    expect(out).toBe("  ECDb: 4.0.0.4 -> 4.0.0.5");
  });

  it("reports a profile that is missing on one side", () => {
    expect(formatProfileChange({}, { ECDb: "4.0.0.5" })).toContain("(absent) -> 4.0.0.5");
  });

  it("lists every profile, one per line", () => {
    const before = { BeSQLite: "3.1.0.2", DgnDb: "2.0.0.7", ECDb: "4.0.0.5" };
    expect(formatProfileChange(before, before).split("\n")).toHaveLength(3);
  });
});

describe("readSchemaVersions", () => {
  it("reads a read.write.minor version for every schema in the iModel", async () => {
    const briefcase = await fixture.createBriefcase("read-schemas");
    const schemas = readSchemaVersions(briefcase.fileName);

    // Every iModel has these, whatever else it contains.
    expect(schemas.BisCore).toBeDefined();
    expect(schemas.ECDbMap).toBeDefined();
    for (const version of Object.values(schemas))
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("findUpgradedSchemas", () => {
  it("reports nothing when no schema moved", () => {
    const same = { BisCore: "1.0.19", Generic: "1.0.4" };
    expect(findUpgradedSchemas(same, same)).toEqual([]);
  });

  it("reports only the schemas whose version changed", () => {
    const before = { BisCore: "1.0.19", Generic: "1.0.4", Unchanged: "1.0.0" };
    const after = { BisCore: "1.0.20", Generic: "1.0.4", Unchanged: "1.0.0" };
    expect(findUpgradedSchemas(before, after)).toEqual([
      { name: "BisCore", from: "1.0.19", to: "1.0.20" },
    ]);
  });

  it("reports a schema the upgrade added", () => {
    expect(findUpgradedSchemas({}, { NewDomain: "1.0.0" })).toEqual([
      { name: "NewDomain", from: undefined, to: "1.0.0" },
    ]);
  });

  it("reports a schema that is no longer present", () => {
    expect(findUpgradedSchemas({ Gone: "1.0.0" }, {})).toEqual([
      { name: "Gone", from: "1.0.0", to: undefined },
    ]);
  });

  it("returns changes in name order", () => {
    const before = { Zeta: "1.0.0", Alpha: "1.0.0" };
    const after = { Zeta: "1.0.1", Alpha: "1.0.1" };
    expect(findUpgradedSchemas(before, after).map((c) => c.name)).toEqual(["Alpha", "Zeta"]);
  });
});

describe("formatSchemaChanges", () => {
  it("formats upgrades, additions and removals", () => {
    const out = formatSchemaChanges([
      { name: "BisCore", from: "1.0.19", to: "1.0.20" },
      { name: "NewDomain", from: undefined, to: "1.0.0" },
      { name: "Gone", from: "1.0.0", to: undefined },
    ]).split("\n");

    expect(out[0]).toBe("  BisCore: 1.0.19 -> 1.0.20");
    expect(out[1]).toBe("  NewDomain: (added) -> 1.0.0");
    expect(out[2]).toBe("  Gone: 1.0.0 -> (removed)");
  });
});

describe("imod util update-profile", () => {
  it("is a no-op on a briefcase that is already current", async () => {
    const briefcase = await fixture.createBriefcase("already-current");
    const before = readProfileVersions(briefcase.fileName);

    const result = await runUpdateProfile({ imodelPath: briefcase.fileName });

    expect(result.schemaState).toBe(SchemaState.UpToDate);
    expect(result.changed).toBe(false);
    expect(result.after).toEqual(before);

    // Nothing moved, so nothing is reported -- unchanged schemas must not be listed.
    expect(result.upgradedSchemas).toEqual([]);
    expect(Object.keys(result.schemasBefore).length).toBeGreaterThan(0);
    expect(result.schemasAfter).toEqual(result.schemasBefore);
  });

  it("dry run writes nothing", async () => {
    const briefcase = await fixture.createBriefcase("dry-run");
    const before = readProfileVersions(briefcase.fileName);
    const mtimeBefore = statSync(briefcase.fileName).mtimeMs;

    const result = await runUpdateProfile({ imodelPath: briefcase.fileName, dryRun: true });

    expect(result.changed).toBe(false);
    expect(result.before).toEqual(before);
    expect(result.after).toEqual(before);
    expect(statSync(briefcase.fileName).mtimeMs).toBe(mtimeBefore);
    expect(readProfileVersions(briefcase.fileName)).toEqual(before);
    expect(result.upgradedSchemas).toEqual([]);
    expect(result.schemasAfter).toEqual(result.schemasBefore);
  });

  it("reports the schema state of a current briefcase", async () => {
    const briefcase = await fixture.createBriefcase("schema-state");
    const result = await runUpdateProfile({ imodelPath: briefcase.fileName, dryRun: true });
    expect(result.schemaState).toBe(SchemaState.UpToDate);
  });

  it("throws when the iModel file does not exist", async () => {
    await expect(runUpdateProfile({ imodelPath: "/no/such/imodel.bim" })).rejects.toThrow(/not found/);
  });
});
