import * as fs from "node:fs";
import * as path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { buildEcsqlHelp, readHelpSources, sourceBaseUrl } from "./build/ecsql-help";

const HELP_DIR = path.join(__dirname, "web", "help");
const HELP_OUTPUT = path.join(__dirname, "web", "public", "help", "ecsql-reference.html");

/**
 * Renders the vendored ECSql reference into the single document the console's help panel
 * fetches.
 *
 * A plugin rather than a prebuild script so that the dev server and a production build go
 * through the same step, and neither depends on remembering to run it first.
 */
function ecsqlHelp(): Plugin {
  const generate = (): void => {
    const html = buildEcsqlHelp(readHelpSources(path.join(HELP_DIR, "ecsqlreference")), {
      sourceBaseUrl: sourceBaseUrl(HELP_DIR),
    });
    fs.mkdirSync(path.dirname(HELP_OUTPUT), { recursive: true });
    fs.writeFileSync(HELP_OUTPUT, html);
  };

  return {
    name: "ecsql-help",
    buildStart: generate,
    configureServer: generate,
  };
}

/**
 * Builds the console frontend into dist/web, which `imod serve console` serves statically.
 *
 * The frontend is a real iTwin.js application: it talks to `imod serve backend` over the
 * standard RPC interfaces, so core-frontend and its dependency tree have to be bundled.
 */
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [ecsqlHelp()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 8000,
  },
  server: { port: 8081 },
});
