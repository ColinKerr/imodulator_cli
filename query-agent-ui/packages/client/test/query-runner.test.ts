import { describe, expect, it } from "vitest";
import { queryRunner, type QueryReader, type QuerySource } from "../src/query-runner";

function source(columns: string[], data: unknown[][], fail?: string): QuerySource & { options: unknown[] } {
  const options: unknown[] = [];
  return {
    options,
    createQueryReader(_ecsql, _params, opts): QueryReader {
      options.push(opts);
      let at = -1;
      return {
        getMetaData: async () => {
          if (fail)
            throw new Error(fail);
          return columns.map((name) => ({ name }));
        },
        step: async () => ++at < data.length,
        get current() {
          return { toArray: () => [...data[at]] };
        },
      };
    },
  };
}

describe("queryRunner", () => {
  it("abbreviates blobs, and pads the short rows toArray gives back", async () => {
    const imodel = source(["a", "b", "c"], [["x"], ["y", 1, 2]]);
    const result = await queryRunner(imodel)("SELECT a, b, c FROM t");
    const got: unknown[][] = [];
    for await (const row of result.rows)
      got.push(row);
    expect(result.columns).toEqual(["a", "b", "c"]);
    expect(got).toEqual([["x", null, null], ["y", 1, 2]]);
    expect(imodel.options).toEqual([{ abbreviateBlobs: true }]);
  });

  it("throws a bad query's error before any row", async () => {
    await expect(queryRunner(source([], [], "No property 'Nope'"))("SELECT Nope FROM t")).rejects.toThrow("No property 'Nope'");
  });
});
