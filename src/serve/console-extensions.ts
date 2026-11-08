import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Console extensions: JavaScript modules the console page loads after it starts, each given the
 * console's extension API (`web/src/extension-api.ts`) to add a side panel tab, buttons under the
 * Assistant's answers, and so on.
 *
 * They are named by `IMOD_CONSOLE_EXTENSIONS`, a comma separated list of local file paths. Only
 * files are accepted, never URLs: an extension runs in the console page with all of the page's
 * rights, so it must be a file the user put on their own machine. The console server serves each
 * one itself, from its own origin, at `/extensions/<n>.js`.
 */

/** The variable that names the extension files. */
export const EXTENSIONS_VARIABLE = "IMOD_CONSOLE_EXTENSIONS";

export interface ConsoleExtensions {
  /** The extension files, resolved, in the order given. */
  files: string[];
  /** Why an entry was left out, one sentence each. */
  problems: string[];
}

/** The extension files the environment names, and why any entry was left out. */
export function consoleExtensionsFromEnv(env: NodeJS.ProcessEnv = process.env): ConsoleExtensions {
  const files: string[] = [];
  const problems: string[] = [];
  const entries = (env[EXTENSIONS_VARIABLE] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      problems.push(`The console extension "${entry}" is a URL; give the path of a local file.`);
      continue;
    }
    const file = path.resolve(entry);
    if (!/\.m?js$/i.test(file)) {
      problems.push(`The console extension "${entry}" is not a .js or .mjs file.`);
      continue;
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      problems.push(`The console extension "${entry}" does not exist.`);
      continue;
    }
    files.push(file);
  }
  return { files, problems };
}

/** Where the page loads extension `index` from. Relative, like the rest of the page's requests. */
export function extensionUrl(index: number): string {
  return `./extensions/${index}.js`;
}
