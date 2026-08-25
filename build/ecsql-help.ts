/**
 * Turns the vendored ECSql reference markdown into the single HTML document the console's
 * help panel shows.
 *
 * One document rather than 27: every cross-page link then becomes a plain anchor within the
 * panel, so there is no navigation to write, and the browser's own find searches the whole
 * reference at once.
 *
 * The sources are a verbatim copy of `docs/learning/ecsqlreference` from itwinjs-core; see
 * web/help/PROVENANCE.json for the commit and web/help/LICENSE.md for the notice.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Marked, type MarkedExtension, type Token, type Tokens } from "marked";

/** The table of contents, and the page order everything else follows. */
const INDEX_FILE = "index.md";

/**
 * Links that are already broken in the source docs: the fragment names no heading in the
 * page it points at. They render as a link to the top of that page instead.
 *
 * Recorded rather than tolerated, so that a sync which breaks a link that used to work
 * fails the build instead of quietly shipping a dead anchor.
 */
export const KNOWN_BROKEN_LINKS: readonly { file: string; href: string }[] = [
  // `RelECClassId` is not lower cased, so it matches no heading id.
  { file: "ECSqlFunctions.md", href: "#navigation_value-ecnavigationproperty-path-id--RelECClassId" },
  // The heading is "Accessing composite properties like `NavigationProperty`, ...", which
  // slugs to far more than this.
  { file: "InstanceQuery.md", href: "#accessing-composite-properties" },
];

function isKnownBroken(link: { from: string; href: string }): boolean {
  return KNOWN_BROKEN_LINKS.some((known) => known.file === link.from && known.href === link.href);
}

export interface HelpOptions {
  /**
   * Where a link that leaves the reference directory points. Links to the rest of the
   * itwinjs-core docs resolve against the pinned commit on GitHub rather than against the
   * documentation site, because the path on GitHub is the one these files were written for
   * and is known to exist.
   */
  sourceBaseUrl: string;
}

/**
 * GitHub's heading slug, which is what the source's own anchors were written against.
 *
 * Lower case, punctuation dropped, whitespace to hyphens. Hyphens and underscores survive,
 * which is why `ec_classname` keeps its underscore.
 *
 * The trim comes after the punctuation is dropped, not before: a heading that ends
 * `... _format-id_] )` leaves a trailing space once the brackets go, and trimming first
 * would turn it into a trailing hyphen that the source's own anchors do not have.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, "")
    .trim()
    .replace(/\s/g, "-");
}

/** The id a file gets as a section, so `./JOIN.md` can be linked as `#join`. */
export function pageSlug(file: string): string {
  return path.basename(file, ".md").toLowerCase();
}

/**
 * Undo the escaping marked applies to text tokens.
 *
 * A heading such as `ec_classId('...')` arrives with its apostrophe as `&#39;`, and slugging
 * that leaves a literal `39` in the id where the source's anchor has nothing at all.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The plain text of inline tokens, which is what a heading is slugged from. */
function plainText(tokens: Token[] | undefined): string {
  if (!tokens)
    return "";
  return tokens
    .map((token) => {
      const inner = (token as Tokens.Generic).tokens as Token[] | undefined;
      // A link or emphasis carries its text in child tokens; code and text carry their own.
      return inner && inner.length > 0 ? plainText(inner) : ((token as Tokens.Generic).text ?? "");
    })
    .join("");
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

interface LinkReference {
  /** The file the link was written in, for the error message. */
  from: string;
  href: string;
  /** The anchor it was rewritten to, which has to exist by the end of the build. */
  target: string;
}

interface RenderedPage {
  file: string;
  slug: string;
  html: string;
}

/** Collected while rendering, checked once every page has contributed its ids. */
interface Collector {
  ids: Set<string>;
  links: LinkReference[];
}

/**
 * Render one page, prefixing every heading id with the page and rewriting every link.
 *
 * Heading text repeats across the reference -- four pages have a `Returns` heading -- so
 * unprefixed ids would collide the moment the pages share a document.
 */
function renderPage(
  file: string,
  markdown: string,
  sources: ReadonlyMap<string, string>,
  collector: Collector,
  options: HelpOptions,
): string {
  const slug = pageSlug(file);
  const usedInPage = new Map<string, number>();

  const rewrite = (href: string): { href: string; external: boolean } => {
    if (/^(https?:|mailto:)/i.test(href))
      return { href, external: true };

    const [target, fragment] = href.split("#");
    const anchor = fragment ? `#${fragment}` : "";

    // Same page: `#some-heading`.
    if (target === "") {
      const rewritten = `#${slug}--${fragment}`;
      collector.links.push({ from: file, href, target: rewritten });
      return { href: rewritten, external: false };
    }

    // Another page of the reference.
    const name = path.basename(target);
    if (target.startsWith("./") && sources.has(name)) {
      const targetSlug = pageSlug(name);
      const rewritten = fragment ? `#${targetSlug}--${fragment}` : `#${targetSlug}`;
      collector.links.push({ from: file, href, target: rewritten });
      return { href: rewritten, external: false };
    }

    if (target.startsWith("./"))
      throw new Error(`${file}: link to a page that is not vendored: ${href}`);

    // Out of the reference directory, so out to the source repository.
    const resolved = path.posix.normalize(path.posix.join("docs/learning/ecsqlreference", target));
    return { href: `${options.sourceBaseUrl}/${resolved}${anchor}`, external: true };
  };

  const extension: MarkedExtension = {
    renderer: {
      heading(token: Tokens.Heading): string {
        const text = this.parser.parseInline(token.tokens);
        const base = slugify(decodeEntities(plainText(token.tokens)));
        // Repeats within one page are numbered, as GitHub numbers them.
        const seen = usedInPage.get(base) ?? 0;
        usedInPage.set(base, seen + 1);
        const id = `${slug}--${base}${seen === 0 ? "" : `-${seen}`}`;
        collector.ids.add(id);
        return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`;
      },
      link(token: Tokens.Link): string {
        const text = this.parser.parseInline(token.tokens);
        const { href, external } = rewrite(token.href);
        const title = token.title ? ` title="${escapeAttribute(token.title)}"` : "";
        const attributes = external ? ` target="_blank" rel="noopener noreferrer"` : "";
        return `<a href="${escapeAttribute(href)}"${title}${attributes}>${text}</a>`;
      },
    },
  };

  return new Marked(extension).parse(markdown, { async: false });
}

/** The order pages appear in: the index first, then the order the index links them. */
export function pageOrder(sources: ReadonlyMap<string, string>): string[] {
  const index = sources.get(INDEX_FILE);
  if (index === undefined)
    throw new Error(`the ECSql reference sources have no ${INDEX_FILE}`);

  const order = [INDEX_FILE];
  for (const match of index.matchAll(/\]\(\.\/([A-Za-z0-9_-]+\.md)/g)) {
    const file = match[1];
    if (sources.has(file) && !order.includes(file))
      order.push(file);
  }
  // A page the index does not link is still part of the reference, so it follows the rest.
  for (const file of [...sources.keys()].sort())
    if (!order.includes(file))
      order.push(file);
  return order;
}

/**
 * Build the help document.
 *
 * Throws when a link cannot be resolved, which is the point: the anchors in these files are
 * written by hand, and a stale one is invisible until someone clicks it.
 */
export function buildEcsqlHelp(sources: ReadonlyMap<string, string>, options: HelpOptions): string {
  const collector: Collector = { ids: new Set(), links: [] };
  const pages: RenderedPage[] = [];

  for (const file of pageOrder(sources)) {
    const slug = pageSlug(file);
    collector.ids.add(slug);
    pages.push({ file, slug, html: renderPage(file, sources.get(file)!, sources, collector, options) });
  }

  const broken = collector.links.filter(
    (link) => !collector.ids.has(link.target.slice(1)) && !isKnownBroken(link),
  );
  if (broken.length > 0) {
    const detail = broken.map((link) => `  ${link.from}: ${link.href} -> ${link.target}`).join("\n");
    throw new Error(`the ECSql reference has ${broken.length} unresolved link(s):\n${detail}`);
  }

  // A known broken fragment still has to lead somewhere, so it falls back to the page top.
  const repaired = new Map(
    collector.links
      .filter((link) => !collector.ids.has(link.target.slice(1)))
      .map((link) => [link.target, `#${link.target.slice(1).split("--")[0]}`]),
  );

  const body = pages
    .map((page) => {
      let html = page.html;
      for (const [from, to] of repaired)
        html = html.replaceAll(`href="${from}"`, `href="${to}"`);
      return `<section id="${page.slug}" class="help-page">\n${html}</section>`;
    })
    .join("\n");

  return `<!-- Generated from web/help/ecsqlreference. Do not edit. -->\n${body}\n`;
}

/** Read the vendored markdown, keyed by file name. */
export function readHelpSources(dir: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of fs.readdirSync(dir).sort())
    if (file.endsWith(".md"))
      sources.set(file, fs.readFileSync(path.join(dir, file), "utf8"));
  return sources;
}

interface Provenance {
  source: string;
  commit: string;
}

/** Where links out of the reference point: the exact commit these files were copied from. */
export function sourceBaseUrl(helpDir: string): string {
  const provenance = JSON.parse(
    fs.readFileSync(path.join(helpDir, "PROVENANCE.json"), "utf8"),
  ) as Provenance;
  return `${provenance.source}/blob/${provenance.commit}`;
}
