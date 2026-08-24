import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  buildEcsqlHelp, pageOrder, readHelpSources, slugify, sourceBaseUrl,
} from "../../../build/ecsql-help";

const HELP_DIR = path.join(__dirname, "..", "..", "..", "web", "help");
const REFERENCE_DIR = path.join(HELP_DIR, "ecsqlreference");
const OPTIONS = { sourceBaseUrl: "https://example.invalid/repo/blob/abc123" };

/** A minimal reference: an index plus the one page it links. */
function sources(extra: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({
    "index.md": "# Contents\n\n- [Joins](./JOIN.md)\n- [Inner](./JOIN.md#inner-join)\n",
    "JOIN.md": "# JOIN\n\n## Inner Join\n\ntext\n",
    ...extra,
  }));
}

describe("slugify", () => {
  it("lower cases and hyphenates", () => {
    expect(slugify("Inner Join")).toBe("inner-join");
  });

  it("keeps underscores and drops punctuation, as GitHub does", () => {
    // The source's own anchors are written against these rules, so they have to match.
    expect(slugify("ec_classname( ECClassId , format-string [, format-id])"))
      .toBe("ec_classname-ecclassid--format-string--format-id");
    expect(slugify("PRAGMA integrity_check (experimental)")).toBe("pragma-integrity_check-experimental");
  });
});

describe("buildEcsqlHelp", () => {
  it("gives each page a section and prefixes its heading ids", () => {
    const html = buildEcsqlHelp(sources(), OPTIONS);
    expect(html).toContain(`<section id="join" class="help-page">`);
    expect(html).toContain(`<h2 id="join--inner-join">`);
  });

  it("rewrites a link to another page as an anchor to its section", () => {
    expect(buildEcsqlHelp(sources(), OPTIONS)).toContain(`<a href="#join">Joins</a>`);
  });

  it("rewrites a link to a heading in another page", () => {
    expect(buildEcsqlHelp(sources(), OPTIONS)).toContain(`<a href="#join--inner-join">Inner</a>`);
  });

  it("rewrites a link within the same page", () => {
    const html = buildEcsqlHelp(sources({ "JOIN.md": "# JOIN\n\n## Inner Join\n\n[up](#inner-join)\n" }), OPTIONS);
    expect(html).toContain(`<a href="#join--inner-join">up</a>`);
  });

  it("numbers headings that repeat within a page", () => {
    const html = buildEcsqlHelp(sources({ "JOIN.md": "# JOIN\n\n## Inner Join\n\n## Returns\n\n## Returns\n" }), OPTIONS);
    expect(html).toContain(`id="join--returns"`);
    expect(html).toContain(`id="join--returns-1"`);
  });

  it("slugs a heading through its escaped characters", () => {
    // The apostrophe reaches the renderer as `&#39;`; slugging that would leave a `39`.
    const html = buildEcsqlHelp(sources({ "JOIN.md": "# JOIN\n\n## Inner Join\n\n## ec_classId('_alias_')\n" }), OPTIONS);
    expect(html).toContain(`id="join--ec_classidalias"`);
  });

  it("opens an external link in a new tab", () => {
    const html = buildEcsqlHelp(sources({ "JOIN.md": "# JOIN\n\n## Inner Join\n\n[sqlite](https://sqlite.org/)\n" }), OPTIONS);
    expect(html).toContain(`<a href="https://sqlite.org/" target="_blank" rel="noopener noreferrer">sqlite</a>`);
  });

  it("sends a link out of the reference directory to the pinned source", () => {
    const html = buildEcsqlHelp(sources({ "JOIN.md": "# JOIN\n\n## Inner Join\n\n[units](../../bis/guide/units.md#si)\n" }), OPTIONS);
    expect(html).toContain(`href="${OPTIONS.sourceBaseUrl}/docs/bis/guide/units.md#si"`);
  });

  it("fails when a fragment names no heading", () => {
    const broken = sources({ "index.md": "# Contents\n\n- [gone](./JOIN.md#outer-join)\n" });
    expect(() => buildEcsqlHelp(broken, OPTIONS)).toThrow(/unresolved link/);
  });

  it("fails when a page it links is not vendored", () => {
    const broken = sources({ "index.md": "# Contents\n\n- [gone](./MISSING.md)\n" });
    expect(() => buildEcsqlHelp(broken, OPTIONS)).toThrow(/not vendored/);
  });
});

describe("the vendored reference", () => {
  const real = readHelpSources(REFERENCE_DIR);

  it("starts with the index and follows its order", () => {
    const order = pageOrder(real);
    expect(order[0]).toBe("index.md");
    expect(order[1]).toBe("Operators.md");
    expect(order).toHaveLength(real.size);
  });

  it("builds, which is what proves every hand written anchor still resolves", () => {
    const html = buildEcsqlHelp(real, { sourceBaseUrl: sourceBaseUrl(HELP_DIR) });
    for (const file of real.keys())
      expect(html).toContain(`<section id="${path.basename(file, ".md").toLowerCase()}"`);
  });

  it("leaves no anchor pointing at an id the document does not have", () => {
    const html = buildEcsqlHelp(real, { sourceBaseUrl: sourceBaseUrl(HELP_DIR) });
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]));
    const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(50);
    expect(targets.filter((target) => !ids.has(target))).toEqual([]);
  });
});
