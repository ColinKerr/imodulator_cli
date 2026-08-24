import { describe, expect, it } from "vitest";
import {
  augmentValue, columnKind, countQuery, explainQuery, isExtraLong, isTruncated, textToRun, toCsv,
} from "../../../web/src/query-shape";
import { formatEcsql } from "../../../web/src/format-ecsql";

describe("textToRun", () => {
  it("runs the selection when there is one", () => {
    expect(textToRun("SELECT 1\nSELECT 2", "SELECT 2")).toBe("SELECT 2");
  });

  it("runs everything when the selection is empty or whitespace", () => {
    expect(textToRun("SELECT 1", "")).toBe("SELECT 1");
    expect(textToRun("SELECT 1", "   ")).toBe("SELECT 1");
    expect(textToRun("SELECT 1", undefined)).toBe("SELECT 1");
  });
});

describe("countQuery", () => {
  it("makes the query a derived table rather than rewriting it", () => {
    expect(countQuery("SELECT ECInstanceId FROM bis.Element")).toBe(
      "SELECT COUNT(*) FROM (SELECT ECInstanceId FROM bis.Element)",
    );
  });

  it("drops a trailing semicolon, which would break the sub-select", () => {
    expect(countQuery("SELECT 1 FROM bis.Element;")).toBe("SELECT COUNT(*) FROM (SELECT 1 FROM bis.Element)");
  });
});

describe("explainQuery", () => {
  it("wraps the query in the explain pragma", () => {
    expect(explainQuery("SELECT 1")).toBe("PRAGMA explain_query('SELECT 1')");
  });

  it("doubles quotes so a literal in the query cannot end the pragma string", () => {
    expect(explainQuery("SELECT 1 WHERE Name='a'")).toBe(
      "PRAGMA explain_query('SELECT 1 WHERE Name=''a''')",
    );
  });
});

describe("columnKind", () => {
  const base = { name: "x", jsonName: "x", typeName: "long", className: "" };

  it("recognises the id extended types ECDb reports", () => {
    expect(columnKind({ ...base, extendedType: "ClassId" })).toBe("classId");
    expect(columnKind({ ...base, extendedType: "Id" })).toBe("id");
  });

  it("recognises a navigation property by its type name", () => {
    // Measured against a real iModel: Model and Parent report typeName "navigation" and no
    // extendedType at all, so keying off "NavId" alone would miss every one of them.
    expect(columnKind({ ...base, name: "Model", typeName: "navigation" })).toBe("navId");
    expect(columnKind({ ...base, typeName: "navigation", extendedType: undefined })).toBe("navId");
    // The ECDbMeta system property does use the extended type, so both are accepted.
    expect(columnKind({ ...base, extendedType: "NavId" })).toBe("navId");
  });

  it("treats anything else as a plain value", () => {
    expect(columnKind({ ...base, typeName: "string" })).toBe("plain");
    expect(columnKind({ ...base, extendedType: "BeGuid" })).toBe("plain");
  });
});

describe("augmentValue", () => {
  const names = new Map([["0x42", "BisCore.Element"]]);

  it("annotates a class id with its schema class name", () => {
    expect(augmentValue("0x42", "classId", names)).toEqual({ text: "0x42", annotation: "(BisCore.Element)" });
  });

  it("leaves a class id alone when the name is unknown", () => {
    expect(augmentValue("0x99", "classId", names)).toEqual({ text: "0x99" });
  });

  it("names the relationship class of a navigation value", () => {
    const relNames = new Map([["0x51", "BisCore.ModelContainsElements"]]);
    const value = { Id: "0x1", RelECClassId: "0x51" };

    expect(augmentValue(value, "navId", relNames)).toEqual({
      text: '{"Id":"0x1","RelECClassId":"0x51"}',
      annotation: "(BisCore.ModelContainsElements)",
    });
  });

  it("leaves a navigation value alone when its relationship class is unknown", () => {
    const value = { Id: "0x1", RelECClassId: "0x999" };
    expect(augmentValue(value, "navId", names)).toEqual({ text: '{"Id":"0x1","RelECClassId":"0x999"}' });
  });

  it("handles a navigation value with no relationship class", () => {
    expect(augmentValue({ Id: "0x1" }, "navId", names)).toEqual({ text: '{"Id":"0x1"}' });
  });

  it("never annotates a plain or instance id column", () => {
    expect(augmentValue("0x42", "id", names)).toEqual({ text: "0x42" });
    expect(augmentValue("0x42", "plain", names)).toEqual({ text: "0x42" });
  });

  it("renders null as empty and objects as JSON", () => {
    expect(augmentValue(null, "plain", names).text).toBe("");
    expect(augmentValue({ id: "0x1" }, "plain", names).text).toBe('{"id":"0x1"}');
  });
});

describe("toCsv", () => {
  it("quotes only the cells that need it", () => {
    const csv = toCsv(["a", "b"], [["plain", 'has "quotes", and a comma']]);
    expect(csv).toBe('a,b\nplain,"has ""quotes"", and a comma"\n');
  });
});

describe("formatEcsql", () => {
  it("breaks at the major clauses", () => {
    expect(formatEcsql("SELECT a, b FROM bis.Element WHERE a=1 ORDER BY b")).toBe(
      "SELECT\n  a, b\nFROM\n  bis.Element\nWHERE\n  a=1\nORDER BY\n  b",
    );
  });

  it("puts joins and connectors on their own lines", () => {
    const out = formatEcsql("SELECT a FROM x INNER JOIN y ON x.id=y.id WHERE a=1 AND b=2");
    expect(out).toContain("\nINNER JOIN y ON x.id=y.id");
    expect(out).toContain("\n  AND b=2");
  });

  it("does not touch the inside of a string literal", () => {
    const out = formatEcsql("SELECT a FROM x WHERE Name='select from where'");
    expect(out).toContain("'select from where'");
  });

  it("leaves a sub-select alone rather than reformatting inside it", () => {
    const out = formatEcsql("SELECT COUNT(*) FROM (SELECT a FROM x WHERE b=1)");
    expect(out).toContain("(SELECT a FROM x WHERE b=1)");
  });

  it("returns empty input unchanged", () => {
    expect(formatEcsql("   ")).toBe("");
  });
});

describe("isExtraLong", () => {
  // A 200px column fits about 176px of text, so ~22 characters.
  it("is false for a value that merely overflows, which a hover can show", () => {
    const value = { text: "x".repeat(30) };
    expect(isTruncated(value, 200)).toBe(true);
    expect(isExtraLong(value, 200)).toBe(false);
  });

  it("is true past twice what the column fits, where a hover is not enough", () => {
    const value = { text: "x".repeat(50) };
    expect(isExtraLong(value, 200)).toBe(true);
  });

  it("is false for a value that fits", () => {
    expect(isExtraLong({ text: "0x1" }, 200)).toBe(false);
  });

  it("counts the annotation, as truncation does", () => {
    const value = { text: "0x51", annotation: "(BisCore.ModelContainsElements)".repeat(2) };
    expect(isExtraLong(value, 120)).toBe(true);
  });
});

describe("isTruncated", () => {
  it("is false when the value fits its column", () => {
    expect(isTruncated({ text: "0x1" }, 200)).toBe(false);
  });

  it("is true when the value is wider than its column", () => {
    expect(isTruncated({ text: "x".repeat(60) }, 200)).toBe(true);
  });

  it("counts the annotation, which is drawn in the same cell", () => {
    const value = { text: "0x51", annotation: "(BisCore.ModelContainsElements)" };
    // The id alone fits; with the class name appended it does not.
    expect(isTruncated({ text: value.text }, 120)).toBe(false);
    expect(isTruncated(value, 120)).toBe(true);
  });

  it("treats an empty value as fitting any column", () => {
    expect(isTruncated({ text: "" }, 48)).toBe(false);
  });
});
