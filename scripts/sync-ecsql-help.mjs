#!/usr/bin/env node
/**
 * Refresh the vendored ECSql reference from a local itwinjs-core checkout.
 *
 *   node scripts/sync-ecsql-help.mjs <path-to-itwinjs-core>
 *
 * Copies docs/learning/ecsqlreference and the licence verbatim and records the commit the
 * copy came from. Run the build afterwards: it fails if a link stopped resolving, which is
 * how a docs change that renames a heading gets noticed.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELP_DIR = path.join(REPO, "web", "help");
const DOCS_PATH = "docs/learning/ecsqlreference";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/sync-ecsql-help.mjs <path-to-itwinjs-core>");
  process.exit(2);
}

const docs = path.join(source, DOCS_PATH);
if (!fs.existsSync(docs)) {
  console.error(`not found: ${docs}`);
  process.exit(2);
}

const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();

const target = path.join(HELP_DIR, "ecsqlreference");
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

let copied = 0;
for (const file of fs.readdirSync(docs)) {
  if (!file.endsWith(".md"))
    continue;
  fs.copyFileSync(path.join(docs, file), path.join(target, file));
  copied++;
}
fs.copyFileSync(path.join(source, "LICENSE.md"), path.join(HELP_DIR, "LICENSE.md"));

const provenance = {
  source: "https://github.com/iTwin/itwinjs-core",
  path: DOCS_PATH,
  published: "https://www.itwinjs.org/learning/ecsqlreference/",
  commit: git("rev-parse", "HEAD"),
  committed: git("log", "-1", "--format=%cI"),
  syncedAt: new Date().toISOString().slice(0, 10),
  license: "MIT, see LICENSE.md",
};
fs.writeFileSync(path.join(HELP_DIR, "PROVENANCE.json"), `${JSON.stringify(provenance, null, 2)}\n`);

console.log(`Copied ${copied} page(s) from ${provenance.commit.slice(0, 12)}.`);
console.log("Now run: npm run build:web");
