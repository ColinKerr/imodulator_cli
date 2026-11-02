import { describe, expect, it } from "vitest";
import { readCapped } from "../src/caps";
import { rows } from "./helpers";

describe("readCapped", () => {
  it("stops before the row past the row cap", async () => {
    const read = await readCapped(rows(["n"], [[1], [2], [3]]), { maxRows: 2, maxChars: 1000, maxCellChars: 10 });
    expect(read).toEqual({ columns: ["n"], rows: [[1], [2]], truncatedBy: "rows" });
  });

  it("stops before the row that would pass the character cap, but always keeps the first", async () => {
    const wide = "x".repeat(30);
    const read = await readCapped(rows(["s"], [[wide], [wide]]), { maxRows: 10, maxChars: 40, maxCellChars: 100 });
    expect(read.rows).toEqual([[wide]]);
    expect(read.truncatedBy).toBe("chars");
  });

  it("cuts long strings and keeps their full length, measuring each line as the function will show it", async () => {
    const long = "y".repeat(50);
    const read = await readCapped(rows(["a", "b"], [[long, 7]]), { maxRows: 10, maxChars: 1000, maxCellChars: 5 });
    expect(read).toEqual({ columns: ["a", "b"], rows: [["yyyyy", 7]], clipped: [[0, 0, 50]] });
  });
});
