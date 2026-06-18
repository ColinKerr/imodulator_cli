import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test/**/*.test.ts"],
    // iTwin.js relies on process-wide native host state (IModelHost) and HubMock
    // allows only one active mock per process, so test files must not run in
    // parallel and must each get a fresh process.
    fileParallelism: false,
    pool: "forks",
    // Opening iModels and downloading mock briefcases can take a few seconds.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
