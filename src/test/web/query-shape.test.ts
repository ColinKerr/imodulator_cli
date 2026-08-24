import { describe, expect, it } from "vitest";
import {
  augmentValue, columnKind, countQuery, explainQuery, textToRun, toCsv,
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
