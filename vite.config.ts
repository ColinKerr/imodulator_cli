import { defineConfig } from "vite";

/**
 * Builds the console frontend into dist/web, which `imod serve console` serves statically.
 *
 * The frontend is a real iTwin.js application: it talks to `imod serve backend` over the
 * standard RPC interfaces, so core-frontend and its dependency tree have to be bundled.
 */
export default defineConfig({
  root: "web",
  base: "./",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 8000,
  },
  server: { port: 8081 },
});
