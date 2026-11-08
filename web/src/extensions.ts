/**
 * Loading the console's extensions (`extension-api.ts`): import each module the console server
 * lists, and call its `activate`. One that fails is reported and left out; the console and the
 * other extensions carry on.
 */

import { CONSOLE_EXTENSION_API_VERSION, type ConsoleExtension, type ConsoleExtensionApi } from "./extension-api";

/** Imports a module by URL. A parameter so the loader can be tested without a browser. */
export type ModuleImporter = (url: string) => Promise<unknown>;

/** The browser's own dynamic import, kept from the bundler, which must not try to resolve it. */
export const importModule: ModuleImporter = (url) => import(/* @vite-ignore */ new URL(url, document.baseURI).href);

/** Load every extension in order. Returns why any could not be loaded, one sentence each. */
export async function loadExtensions(urls: readonly string[], api: ConsoleExtensionApi, importer: ModuleImporter = importModule): Promise<string[]> {
  const problems: string[] = [];
  for (const url of urls) {
    try {
      const extension = asExtension(await importer(url));
      if (typeof extension === "string") {
        problems.push(`Console extension ${url}: ${extension}`);
        continue;
      }
      await extension.activate(api);
    } catch (err) {
      problems.push(`Console extension ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems;
}

/** The module as an extension, or why it is not one. */
function asExtension(module: unknown): ConsoleExtension | string {
  const candidate = (typeof module === "object" && module !== null ? module : {}) as Partial<ConsoleExtension> & { default?: Partial<ConsoleExtension> };
  // A module may export `activate` itself, or a default object that has it.
  const extension = typeof candidate.activate === "function" ? candidate : candidate.default;
  if (typeof extension?.activate !== "function")
    return "it exports no activate function.";
  if (extension.apiVersion !== undefined && extension.apiVersion !== CONSOLE_EXTENSION_API_VERSION)
    return `it was written for extension API ${extension.apiVersion}; this console has ${CONSOLE_EXTENSION_API_VERSION}.`;
  return extension as ConsoleExtension;
}
