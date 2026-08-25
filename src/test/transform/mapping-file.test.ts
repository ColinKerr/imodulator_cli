import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMappingFile, parseMapping, toClassFullName } from "../../transform/mapping-file";

const VALID = {
  ElementMapping: {
    ClassMappings: [
      {
        SourceClass: "Generic.PhysicalObject",
        TargetClass: "Test:TargetClass",
        Options: { AutoMapLikeNamedProperties: true },
        PropertyMappings: [
          { SourceProperty: "Banana", TargetProperty: "Apple", Options: { DefaultValueIfEmpty: 42 } },
        ],
      },
    ],
  },
};

describe("transform using-map mapping file", () => {
  describe("parseMapping (valid)", () => {
    it("accepts a well-formed mapping and preserves its contents", () => {
      const result = parseMapping(VALID);
      const cm = result.ElementMapping.ClassMappings[0];
      expect(cm.SourceClass).toBe("Generic.PhysicalObject");
      expect(cm.TargetClass).toBe("Test:TargetClass");
      expect(cm.Options?.AutoMapLikeNamedProperties).toBe(true);
      expect(cm.PropertyMappings?.[0]).toEqual({
        SourceProperty: "Banana",
        TargetProperty: "Apple",
        Options: { DefaultValueIfEmpty: 42 },
      });
    });

    it("accepts a minimal mapping with no Options or PropertyMappings", () => {
      const result = parseMapping({
        ElementMapping: { ClassMappings: [{ SourceClass: "A:B", TargetClass: "C:D" }] },
      });
      expect(result.ElementMapping.ClassMappings).toHaveLength(1);
    });

    it("allows DefaultValueIfEmpty of string, boolean, and null", () => {
      for (const v of ["x", true, null]) {
        const result = parseMapping({
          ElementMapping: {
            ClassMappings: [
              {
                SourceClass: "A:B",
                TargetClass: "C:D",
                PropertyMappings: [{ SourceProperty: "P", TargetProperty: "Q", Options: { DefaultValueIfEmpty: v } }],
              },
            ],
          },
        });
        expect(result.ElementMapping.ClassMappings[0].PropertyMappings?.[0].Options?.DefaultValueIfEmpty).toBe(v);
      }
    });
  });

  describe("parseMapping (invalid)", () => {
    it("rejects a missing ElementMapping", () => {
      expect(() => parseMapping({})).toThrow(/Unexpected key|ElementMapping/);
    });

    it("rejects an empty ClassMappings array", () => {
      expect(() => parseMapping({ ElementMapping: { ClassMappings: [] } })).toThrow(/non-empty array/);
    });

    it("rejects an unqualified source class name", () => {
      expect(() =>
        parseMapping({ ElementMapping: { ClassMappings: [{ SourceClass: "PhysicalObject", TargetClass: "C:D" }] } }),
      ).toThrow(/SourceClass must be a fully qualified EC class name/);
    });

    it("rejects unknown keys", () => {
      expect(() =>
        parseMapping({
          ElementMapping: { ClassMappings: [{ SourceClass: "A:B", TargetClass: "C:D", Nope: 1 }] },
        }),
      ).toThrow(/Unexpected key\(s\).*Nope/);
    });

    it("rejects duplicate source classes", () => {
      expect(() =>
        parseMapping({
          ElementMapping: {
            ClassMappings: [
              { SourceClass: "A:B", TargetClass: "C:D" },
              { SourceClass: "A:B", TargetClass: "E:F" },
            ],
          },
        }),
      ).toThrow(/Duplicate SourceClass "A:B"/);
    });

    it("rejects duplicate target properties within a class mapping", () => {
      expect(() =>
        parseMapping({
          ElementMapping: {
            ClassMappings: [
              {
                SourceClass: "A:B",
                TargetClass: "C:D",
                PropertyMappings: [
                  { SourceProperty: "P", TargetProperty: "Same" },
                  { SourceProperty: "Q", TargetProperty: "Same" },
                ],
              },
            ],
          },
        }),
      ).toThrow(/Duplicate TargetProperty "Same"/);
    });

    it("rejects a non-scalar DefaultValueIfEmpty", () => {
      expect(() =>
        parseMapping({
          ElementMapping: {
            ClassMappings: [
              {
                SourceClass: "A:B",
                TargetClass: "C:D",
                PropertyMappings: [{ SourceProperty: "P", TargetProperty: "Q", Options: { DefaultValueIfEmpty: { x: 1 } } }],
              },
            ],
          },
        }),
      ).toThrow(/DefaultValueIfEmpty must be/);
    });
  });

  describe("loadMappingFile", () => {
    it("loads and validates a file from disk", () => {
      const dir = mkdtempSync(join(tmpdir(), "imod-mapping-"));
      try {
        const file = join(dir, "map.json");
        writeFileSync(file, JSON.stringify(VALID), "utf8");
        expect(loadMappingFile(file).ElementMapping.ClassMappings).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("throws for a missing file", () => {
      expect(() => loadMappingFile(join(tmpdir(), "does-not-exist-imod.json"))).toThrow(/not found or unreadable/);
    });

    it("throws for malformed JSON", () => {
      const dir = mkdtempSync(join(tmpdir(), "imod-mapping-bad-"));
      try {
        const file = join(dir, "bad.json");
        writeFileSync(file, "{ not json", "utf8");
        expect(() => loadMappingFile(file)).toThrow(/not valid JSON/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("toClassFullName", () => {
    it("converts dotted names to colon form and leaves colon form unchanged", () => {
      expect(toClassFullName("Generic.PhysicalObject")).toBe("Generic:PhysicalObject");
      expect(toClassFullName("Generic:PhysicalObject")).toBe("Generic:PhysicalObject");
    });
  });
});
