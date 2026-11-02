import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { BriefcaseDb, PhysicalModel, SpatialCategory } from "@itwin/core-backend";
import { IModel, SubCategoryAppearance } from "@itwin/core-common";
import { runDropTxns } from "../../../commands/util/drop-txns";
import { HubMockFixture } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();

beforeAll(async () => {
  await fixture.startup("drop-txns");
});

afterAll(async () => {
  await fixture.shutdown();
});

/** A briefcase with a model inserted and saved, so it has a pending txn. */
async function seedBriefcaseWithTxn(name: string): Promise<{ fileName: string; modelId: string }> {
  const briefcase = await fixture.createBriefcase(name);
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  try {
    SpatialCategory.insert(db, IModel.dictionaryId, `${name}-cat`, new SubCategoryAppearance());
    const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, `${name}-model`);
    db.saveChanges();
    expect(db.txns.hasPendingTxns).toBe(true);
    return { fileName: briefcase.fileName, modelId };
  } finally {
    db.close();
  }
}

/** Opens the briefcase to report whether it has pending txns and whether the model survived. */
async function inspect(fileName: string, modelId: string): Promise<{ hasPendingTxns: boolean; modelExists: boolean }> {
  const db = await BriefcaseDb.open({ fileName, readonly: true });
  try {
    return {
      hasPendingTxns: db.txns.hasPendingTxns,
      modelExists: db.models.tryGetModelProps(modelId) !== undefined,
    };
  } finally {
    db.close();
  }
}

describe("imod util drop-txns", () => {
  it("drops pending txns and keeps the changes in the file by default", async () => {
    const { fileName, modelId } = await seedBriefcaseWithTxn("keep");

    const result = await runDropTxns({ imodelPath: fileName });

    expect(result).toMatchObject({ hadUnsavedChanges: false, hadPendingTxns: true, discardedChanges: false });
    expect(await inspect(fileName, modelId)).toEqual({ hasPendingTxns: false, modelExists: true });
  });

  it("vacuums the iModel after dropping txns", async () => {
    const { fileName } = await seedBriefcaseWithTxn("vacuum");

    const result = await runDropTxns({ imodelPath: fileName });

    expect(result.bytesBefore).toBeGreaterThan(0);
    expect(result.bytesAfter).toBe(statSync(fileName).size);
    // Dropping the txns frees their pages, which only vacuum gives back.
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(result.vacuumMs).toBeGreaterThanOrEqual(0);
  });

  it("reverts the changes when discard-changes is set", async () => {
    const { fileName, modelId } = await seedBriefcaseWithTxn("discard");

    const result = await runDropTxns({ imodelPath: fileName, discardChanges: true });

    expect(result).toMatchObject({ hadUnsavedChanges: false, hadPendingTxns: true, discardedChanges: true });
    expect(await inspect(fileName, modelId)).toEqual({ hasPendingTxns: false, modelExists: false });
  });

  it("succeeds when there are no txns to drop", async () => {
    const briefcase = await fixture.createBriefcase("empty");

    const result = await runDropTxns({ imodelPath: briefcase.fileName });

    expect(result).toMatchObject({ hadUnsavedChanges: false, hadPendingTxns: false, discardedChanges: false });
  });

  it("leaves the iModel closed so it can be run again", async () => {
    const { fileName } = await seedBriefcaseWithTxn("twice");

    await runDropTxns({ imodelPath: fileName });
    await expect(runDropTxns({ imodelPath: fileName })).resolves.toMatchObject({ hadPendingTxns: false });
  });

  it("throws when the iModel file does not exist", async () => {
    await expect(runDropTxns({ imodelPath: "/no/such/imodel.bim" })).rejects.toThrow(/not found/);
  });
});
